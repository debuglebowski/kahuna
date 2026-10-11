import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  googleConnection,
  googleGmailMessage,
  googleGmailSync,
  googleGmailThread,
  googleObjectLink,
} from "#db"
import { FieldService, RecordService } from "#engine"
import { auth } from "./auth"
import { db, pool } from "./db"
import { provisionConcept, upsertRecordVersionByExternalId } from "./integrations/records"
import { createUserDirect } from "./provision"
import { runEngineOrThrow, systemScope } from "./runtime"

/**
 * Migration 0026 removes mail the old Gmail mirror copied: the mirror rows, and the
 * connector-owned values in the Email records AND in the event log (record purge
 * keeps events, so a purged record's subject would otherwise survive there).
 *
 * The real SQL file is run against records built through the engine, so the events
 * carry the payloads the engine actually writes.
 */

const MIGRATION = path.resolve(
  import.meta.dirname,
  "../db/migrations/0026_gmail_disabled_cleanup.sql",
)

const runMigration = async () => {
  for (const stmt of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) {
    if (stmt.trim()) await pool.query(stmt)
  }
}

const newOrg = async () => {
  const created = await createUserDirect({
    email: `u-${randomUUID()}@test.dev`,
    password: "password12345",
    name: "Tester",
  })
  const org = await auth.api.createOrganization({
    body: {
      name: `Org ${randomUUID().slice(0, 8)}`,
      slug: `org-${randomUUID().slice(0, 8)}`,
      userId: created.userId,
    },
  })
  if (!org) throw new Error("createOrganization returned null")
  return { orgId: org.id, userId: created.userId }
}

const stateOf = async (id: string) =>
  (
    await pool.query<{ state: Record<string, unknown>; archived_at: Date | null }>(
      `SELECT state, archived_at FROM record_versions WHERE id = $1`,
      [id],
    )
  ).rows[0]

const eventsOf = async (id: string) =>
  (
    await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM events WHERE subject_id = $1 ORDER BY id`,
      [id],
    )
  ).rows

const count = async (sql: string, params: unknown[]) =>
  Number((await pool.query<{ n: string }>(sql, params)).rows[0]?.n)

describe("migration 0026: Gmail cleanup", () => {
  it("removes mirror rows, blanks Email records and scrubs the event log, leaving the rest", async () => {
    const { orgId, userId } = await newOrg()
    const scope = systemScope(orgId, userId)

    // ── An Email concept as the connector provisions it, plus a user-added field.
    const email = await provisionConcept(scope, {
      name: "Google - Email",
      managedBy: "google.gmail",
      titleFieldKey: "subject",
      fields: [
        { key: "externalId", name: "Thread ID", kind: "text", config: { unique: true } },
        { key: "subject", name: "Subject", kind: "text" },
        { key: "from", name: "From", kind: "text" },
      ],
    })
    const note = await runEngineOrThrow(
      scope,
      Effect.flatMap(FieldService, (f) =>
        f.addField({ conceptId: email.conceptId, name: "Note", kind: "text" }),
      ),
    )
    const f = email.fieldMap as Record<string, string>

    const upsert = (thread: string, fields: Record<string, unknown>) =>
      upsertRecordVersionByExternalId(scope, {
        conceptId: email.conceptId,
        externalFieldId: f.externalId!,
        externalValue: thread,
        fields,
      })

    // Kept record: created, then updated (a second event holding the new subject).
    await upsert("t-kept", {
      [f.externalId!]: "t-kept",
      [f.subject!]: "Salary review",
      [f.from!]: "ada@example.test",
      [note.id]: "a person typed this",
    })
    const kept = (
      await upsert("t-kept", { [f.externalId!]: "t-kept", [f.subject!]: "Re: Salary review" })
    ).recordVersion

    // Purged record: the row is gone, the events stay by design.
    const gone = (
      await upsert("t-gone", { [f.externalId!]: "t-gone", [f.subject!]: "Resignation letter" })
    ).recordVersion
    await runEngineOrThrow(
      scope,
      Effect.flatMap(RecordService, (r) => r.purge({ recordVersionId: gone.id })),
    )

    // Control: an ordinary concept the migration must not touch.
    const plain = await provisionConcept(scope, {
      name: "Plain",
      fields: [{ key: "a", name: "A", kind: "text" }],
    })
    const control = await runEngineOrThrow(
      scope,
      Effect.flatMap(RecordService, (r) =>
        r.create({ conceptId: plain.conceptId, fields: { [plain.fieldMap.a!]: "untouched" } }),
      ),
    )

    // ── Gmail mirror rows + links.
    const [conn] = await db
      .insert(googleConnection)
      .values({ orgId, userId, scopes: "x", gmailConceptId: email.conceptId })
      .returning()
    if (!conn) throw new Error("missing connection")
    await db.insert(googleGmailThread).values({
      connectionId: conn.id,
      orgId,
      userId,
      threadId: "t-kept",
      subject: "Salary review",
      snippet: "body excerpt",
      raw: { snippet: "body excerpt" },
    })
    await db.insert(googleGmailMessage).values({
      connectionId: conn.id,
      orgId,
      userId,
      messageId: "m-1",
      threadId: "t-kept",
      bodyText: "the whole body",
      raw: { payload: "the whole body" },
    })
    await db.insert(googleGmailSync).values({ connectionId: conn.id, historyId: "9" })
    await db.insert(googleObjectLink).values([
      { orgId, userId, providerKind: "gmail_thread", providerId: "t-kept", recordId: "rec-1" },
      { orgId, userId, providerKind: "calendar_event", providerId: "e-1", recordId: "rec-1" },
    ])

    // Sanity: the values really are in the log and the row before the migration, so
    // this test would fail without it.
    expect(JSON.stringify(await eventsOf(gone.id))).toContain("Resignation letter")
    expect(JSON.stringify(await eventsOf(kept.id))).toContain("Re: Salary review")
    expect((await stateOf(kept.id))?.state[f.subject!]).toBe("Re: Salary review")

    await runMigration()

    // ── Mirror rows and the Gmail link are gone; the Calendar link stays.
    for (const table of ["google_gmail_thread", "google_gmail_message", "google_gmail_sync"]) {
      expect(
        await count(`SELECT count(*) AS n FROM ${table} WHERE connection_id = $1`, [conn.id]),
      ).toBe(0)
    }
    const links = await pool.query<{ provider_kind: string }>(
      `SELECT provider_kind FROM google_object_link WHERE org_id = $1`,
      [orgId],
    )
    expect(links.rows.map((r) => r.provider_kind)).toEqual(["calendar_event"])

    // ── The record: connector-owned values gone, user field kept, archived.
    const row = await stateOf(kept.id)
    expect(row?.archived_at).not.toBeNull()
    expect(row?.state).toEqual({ [note.id]: "a person typed this" })
    expect(
      await count(
        `SELECT count(*) AS n FROM records WHERE concept_id = $1 AND archived_at IS NULL`,
        [email.conceptId],
      ),
    ).toBe(0)

    // ── The log: no subject or sender anywhere, including the purged record's. The
    //    event rows, types and the user field's value are still there.
    for (const id of [kept.id, gone.id]) {
      const text = JSON.stringify(await eventsOf(id))
      for (const secret of ["Salary review", "Resignation letter", "ada@example.test"]) {
        expect(text, `${id} still holds "${secret}"`).not.toContain(secret)
      }
    }
    const keptEvents = await eventsOf(kept.id)
    expect(keptEvents.map((e) => e.event_type)).toEqual([
      "RecordVersionCreated",
      "RecordVersionUpdated",
    ])
    expect((keptEvents[0]?.payload.fields as Record<string, unknown>)[note.id]).toBe(
      "a person typed this",
    )
    expect((await eventsOf(gone.id)).map((e) => e.event_type)).toEqual([
      "RecordVersionCreated",
      "RecordVersionPurged",
    ])

    // ── Control data is untouched.
    const controlRow = await stateOf(control.id)
    expect(controlRow?.archived_at).toBeNull()
    expect(controlRow?.state).toEqual({ [plain.fieldMap.a!]: "untouched" })
    expect(JSON.stringify(await eventsOf(control.id))).toContain("untouched")

    // ── Idempotent: a second run finds nothing to do and changes nothing.
    const before = JSON.stringify([await stateOf(kept.id), await eventsOf(kept.id)])
    await runMigration()
    expect(JSON.stringify([await stateOf(kept.id), await eventsOf(kept.id)])).toBe(before)
  })

  it("runs cleanly when the org never had a Gmail concept", async () => {
    await newOrg()
    await expect(runMigration()).resolves.toBeUndefined()
  })
})
