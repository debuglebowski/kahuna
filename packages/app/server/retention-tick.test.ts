import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { auth } from "./auth"
import { pool } from "./db"
import { createUserDirect } from "./provision"
import { type RetentionConfig, retentionConfigFromEnv, runRetention } from "./retention-tick"

const DAY = 86_400_000
const NOW = new Date("2026-06-01T12:00:00Z")
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

const CFG: RetentionConfig = {
  auditDays: 365,
  gmailUnlinkedDays: 30,
  deletedUpstreamDays: 30,
  disconnectedDays: 30,
  dedupeDays: 30,
  clayJobDays: 90,
}

const newUser = async () => {
  const created = await createUserDirect({
    email: `u-${randomUUID()}@test.dev`,
    password: "password12345",
    name: "Tester",
  })
  return created.userId
}

const newOrg = async () => {
  const userId = await newUser()
  const org = await auth.api.createOrganization({
    body: {
      name: `Org ${randomUUID().slice(0, 8)}`,
      slug: `org-${randomUUID().slice(0, 8)}`,
      userId,
    },
  })
  if (!org) throw new Error("createOrganization returned null")
  return { orgId: org.id, userId }
}

const count = async (table: string, where: string, params: unknown[]): Promise<number> => {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
    params,
  )
  return r.rows[0]?.n ?? 0
}

const googleConnection = async (orgId: string, userId: string, disconnectedAt?: Date) => {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO google_connection (org_id, user_id, status, disconnected_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, userId, disconnectedAt ? "disconnected" : "connected", disconnectedAt ?? null],
  )
  return r.rows[0]?.id as string
}

describe("retentionConfigFromEnv", () => {
  it("defaults, overrides, 0 disables, garbage falls back", () => {
    expect(retentionConfigFromEnv({})).toEqual(CFG)
    const cfg = retentionConfigFromEnv({
      RETENTION_AUDIT_DAYS: "730",
      RETENTION_DEDUPE_DAYS: "0",
      RETENTION_CLAY_JOB_DAYS: "abc",
      RETENTION_GMAIL_UNLINKED_DAYS: "-5",
    })
    expect(cfg.auditDays).toBe(730)
    expect(cfg.dedupeDays).toBe(0)
    expect(cfg.clayJobDays).toBe(90)
    expect(cfg.gmailUnlinkedDays).toBe(30)
  })
})

describe("runRetention", () => {
  it("purges audit logs past the period in every audit table, keeps newer ones", async () => {
    const { orgId, userId } = await newOrg()
    const tables = [
      "google_audit_log",
      "posthog_audit_log",
      "linear_audit_log",
      "slack_audit_log",
      "apollo_audit_log",
      "clay_audit_log",
    ]
    for (const t of tables) {
      for (const [days, action] of [
        [400, "old"],
        [364, "recent"],
      ] as const) {
        await pool.query(
          `INSERT INTO ${t} (org_id, user_id, action, created_at) VALUES ($1, $2, $3, $4)`,
          [orgId, userId, action, ago(days)],
        )
      }
    }
    const res = await runRetention(pool, CFG, NOW)
    expect(res.errors).toEqual({})
    for (const t of tables) {
      expect(await count(t, "org_id = $1 AND action = 'old'", [orgId])).toBe(0)
      expect(await count(t, "org_id = $1 AND action = 'recent'", [orgId])).toBe(1)
    }
  })

  it("deletes in batches until nothing expired is left", async () => {
    const { orgId, userId } = await newOrg()
    await pool.query(
      `INSERT INTO google_audit_log (org_id, user_id, action, created_at)
       SELECT $1, $2, 'bulk', $3 FROM generate_series(1, 2500)`,
      [orgId, userId, ago(500)],
    )
    const res = await runRetention(pool, CFG, NOW)
    expect(res.deleted["audit:google_audit_log"]).toBeGreaterThanOrEqual(2500)
    expect(await count("google_audit_log", "org_id = $1", [orgId])).toBe(0)
  })

  it("a period of 0 disables the rule", async () => {
    const { orgId, userId } = await newOrg()
    await pool.query(
      `INSERT INTO google_audit_log (org_id, user_id, action, created_at) VALUES ($1, $2, 'old', $3)`,
      [orgId, userId, ago(900)],
    )
    const res = await runRetention(pool, { ...CFG, auditDays: 0 }, NOW)
    expect(Object.keys(res.deleted).some((k) => k.startsWith("audit:"))).toBe(false)
    expect(await count("google_audit_log", "org_id = $1", [orgId])).toBe(1)
  })

  it("Gmail: unlinked old copies go, linked ones and recent ones stay", async () => {
    const { orgId, userId } = await newOrg()
    const conn = await googleConnection(orgId, userId)
    const thread = (id: string, lastMessage: Date) =>
      pool.query(
        `INSERT INTO google_gmail_thread (connection_id, org_id, user_id, thread_id, last_message_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [conn, orgId, userId, id, lastMessage],
      )
    const message = (id: string, threadId: string, sentAt: Date) =>
      pool.query(
        `INSERT INTO google_gmail_message (connection_id, org_id, user_id, message_id, thread_id, sent_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [conn, orgId, userId, id, threadId, sentAt],
      )
    await thread("t-unlinked", ago(60))
    await message("m-unlinked", "t-unlinked", ago(60))
    await thread("t-linked", ago(60))
    await message("m-linked", "t-linked", ago(60))
    await pool.query(
      `INSERT INTO google_object_link (org_id, user_id, provider_kind, provider_id, record_id)
       VALUES ($1, $2, 'gmail_thread', 't-linked', 'rec-1')`,
      [orgId, userId],
    )
    await thread("t-recent", ago(5))
    await message("m-recent", "t-recent", ago(5))
    // An old message inside a thread that is still active must not be stripped from it.
    await message("m-old-in-live-thread", "t-recent", ago(90))

    const res = await runRetention(pool, CFG, NOW)
    expect(res.errors).toEqual({})

    const ids = async (table: string, col: string) =>
      (
        await pool.query<{ id: string }>(`SELECT ${col} AS id FROM ${table} WHERE org_id = $1`, [
          orgId,
        ])
      ).rows
        .map((r) => r.id)
        .sort()
    expect(await ids("google_gmail_thread", "thread_id")).toEqual(["t-linked", "t-recent"])
    expect(await ids("google_gmail_message", "message_id")).toEqual([
      "m-linked",
      "m-old-in-live-thread",
      "m-recent",
    ])
  })

  it("deleted-upstream markers go after the period; live rows stay however old", async () => {
    const { orgId, userId } = await newOrg()
    const conn = await googleConnection(orgId, userId)
    const event = (id: string, deletedAt: Date | null) =>
      pool.query(
        `INSERT INTO google_calendar_event (connection_id, org_id, user_id, google_event_id, start_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [conn, orgId, userId, id, ago(800), deletedAt],
      )
    await event("gone-old", ago(40))
    await event("gone-recent", ago(10))
    await event("live-old", null)

    await runRetention(pool, CFG, NOW)
    const rows = await pool.query<{ google_event_id: string }>(
      `SELECT google_event_id FROM google_calendar_event WHERE org_id = $1 ORDER BY 1`,
      [orgId],
    )
    expect(rows.rows.map((r) => r.google_event_id)).toEqual(["gone-recent", "live-old"])
  })

  it("mirror data and sync cursors of a long-disconnected connection go; connected ones stay", async () => {
    const { orgId, userId } = await newOrg()
    const otherUser = await newUser()
    const disconnected = await googleConnection(orgId, userId, ago(40))
    const recentlyDisconnected = await googleConnection(orgId, otherUser, ago(5))
    for (const conn of [disconnected, recentlyDisconnected]) {
      await pool.query(
        `INSERT INTO google_calendar_event (connection_id, org_id, user_id, google_event_id)
         VALUES ($1, $2, $3, 'ev')`,
        [conn, orgId, conn === disconnected ? userId : otherUser],
      )
      await pool.query(
        `INSERT INTO google_gmail_sync (connection_id, history_id) VALUES ($1, '1')`,
        [conn],
      )
    }

    await runRetention(pool, CFG, NOW)
    expect(await count("google_calendar_event", "connection_id = $1", [disconnected])).toBe(0)
    expect(await count("google_gmail_sync", "connection_id = $1", [disconnected])).toBe(0)
    expect(await count("google_calendar_event", "connection_id = $1", [recentlyDisconnected])).toBe(
      1,
    )
    expect(await count("google_gmail_sync", "connection_id = $1", [recentlyDisconnected])).toBe(1)
    // The connection row itself stays: reconnecting must not need a new one.
    expect(await count("google_connection", "id = $1", [disconnected])).toBe(1)
  })

  it("dedupe rows expire; finished Clay jobs expire, pending ones don't", async () => {
    const { orgId, userId } = await newOrg()
    for (const [key, days] of [
      [`old-${randomUUID()}`, 45],
      [`new-${randomUUID()}`, 5],
    ] as const) {
      await pool.query(
        `INSERT INTO slack_event (org_id, dedupe_key, received_at) VALUES ($1, $2, $3)`,
        [orgId, key, ago(days)],
      )
    }
    expect(await count("slack_event", "org_id = $1", [orgId])).toBe(2)

    const clay = await pool.query<{ id: string }>(
      `INSERT INTO clay_connection (org_id, user_id) VALUES ($1, $2) RETURNING id`,
      [orgId, userId],
    )
    const clayId = clay.rows[0]?.id as string
    for (const [status, days] of [
      ["done", 120],
      ["error", 120],
      ["pending", 120],
      ["done", 10],
    ] as const) {
      await pool.query(
        `INSERT INTO clay_job (org_id, connection_id, status, pushed_at) VALUES ($1, $2, $3, $4)`,
        [orgId, clayId, status, ago(days)],
      )
    }

    await runRetention(pool, CFG, NOW)
    expect(await count("slack_event", "org_id = $1", [orgId])).toBe(1)
    const jobs = await pool.query<{ status: string }>(
      `SELECT status FROM clay_job WHERE org_id = $1 ORDER BY status, pushed_at`,
      [orgId],
    )
    expect(jobs.rows.map((r) => r.status)).toEqual(["done", "pending"])
  })

  it("never touches the engine event log", async () => {
    const { orgId } = await newOrg()
    const subjectId = randomUUID()
    await pool.query(
      `INSERT INTO events (org_id, occurred_at, actor, subject_kind, subject_id, event_type, payload)
       VALUES ($1, $2, 'test', 'record', $3, 'RecordCreated', '{}')`,
      [orgId, ago(3000), subjectId],
    )
    await runRetention(
      pool,
      {
        auditDays: 1,
        gmailUnlinkedDays: 1,
        deletedUpstreamDays: 1,
        disconnectedDays: 1,
        dedupeDays: 1,
        clayJobDays: 1,
      },
      NOW,
    )
    // Seeding an org appends its own events concurrently, so match ours by subject.
    expect(await count("events", "org_id = $1 AND subject_id = $2", [orgId, subjectId])).toBe(1)
  })
})
