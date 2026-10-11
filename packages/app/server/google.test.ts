import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  googleCalendarEvent,
  googleCalendarSync,
  googleConnection,
  googleGmailMessage,
  googleGmailSync,
  googleGmailThread,
  googleNotification,
  googleOAuthState,
  orgIntegrationSettings,
} from "#db"
import { auth } from "./auth"
import { db, pool } from "./db"
import {
  decryptToken,
  encryptToken,
  GOOGLE_SCOPES,
  getGoogleThread,
  googleRequest,
  googleStatus,
  handleCalendarPush,
  handleGmailPush,
  handleGoogleCallback,
  handleGoogleConnect,
  listGoogleThreads,
  renewWatches,
  sendGoogleMail,
  setGoogleFetchForTest,
  syncGoogleConnection,
} from "./google"
import { updateIntegrationSettings } from "./integrationSettings"
import { createUserDirect } from "./provision"

const cookieHeader = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ")

const signUpAndOrg = async () => {
  const email = `u-${randomUUID()}@test.dev`
  const password = "password12345"
  const created = await createUserDirect({ email, password, name: "Tester" })
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
  const headers = new Headers({ cookie: cookieHeader(signIn) })
  const org = await auth.api.createOrganization({
    body: {
      name: `Org ${randomUUID().slice(0, 8)}`,
      slug: `org-${randomUUID().slice(0, 8)}`,
      userId: created.userId,
    },
  })
  if (!org) throw new Error("createOrganization returned null")
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers })
  const session = await auth.api.getSession({ headers })
  if (!session?.user) throw new Error("missing session")
  return { headers, orgId: org.id, userId: session.user.id }
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

const instanceStates = async (
  orgId: string,
  conceptId: string,
): Promise<Record<string, unknown>[]> => {
  const r = await pool.query<{ state: Record<string, unknown> }>(
    `SELECT state FROM record_versions WHERE org_id = $1 AND concept_id = $2 AND archived_at IS NULL`,
    [orgId, conceptId],
  )
  return r.rows.map((row) => row.state)
}

describe("Google integration", () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "client"
    process.env.GOOGLE_CLIENT_SECRET = "secret"
    process.env.GOOGLE_REDIRECT_URI = "http://localhost/api/integrations/google/callback"
    process.env.INTEGRATION_ENCRYPTION_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    process.env.GOOGLE_SYNC_ENABLED = "0"
    process.env.GOOGLE_WATCH_ENABLED = "0"
  })

  afterEach(() => {
    setGoogleFetchForTest(fetch)
    process.env = { ...oldEnv }
  })

  it("exchanges an OAuth callback and stores encrypted tokens", async () => {
    const actor = await signUpAndOrg()
    await db.insert(googleOAuthState).values({
      state: "state-1",
      orgId: actor.orgId,
      userId: actor.userId,
      scopes: GOOGLE_SCOPES.calendarEvents,
      returnTo: "/settings/integrations",
      expiresAt: new Date(Date.now() + 60_000),
    })
    const urls: string[] = []
    setGoogleFetchForTest(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.includes("oauth2.googleapis.com/token")) {
        return okJson({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          scope: GOOGLE_SCOPES.calendarEvents,
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    const res = await handleGoogleCallback(
      new Request("http://localhost/api/integrations/google/callback?code=abc&state=state-1", {
        headers: actor.headers,
      }),
    )

    expect(res.status).toBe(302)
    const [connection] = await db
      .select()
      .from(googleConnection)
      .where(
        and(eq(googleConnection.orgId, actor.orgId), eq(googleConnection.userId, actor.userId)),
      )
      .limit(1)
    // The profile (and so the address) comes from the Gmail API, which is not called.
    expect(connection?.email).toBeNull()
    expect(urls.some((u) => u.includes("/gmail/"))).toBe(false)
    expect(connection?.accessToken).not.toBe("access-1")
    expect(decryptToken(connection?.accessToken)).toBe("access-1")
    expect(decryptToken(connection?.refreshToken)).toBe("refresh-1")
  })

  it("refreshes an expired token and syncs Calendar events", async () => {
    const actor = await signUpAndOrg()
    const [connection] = await db
      .insert(googleConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        scopes: GOOGLE_SCOPES.calendarEvents,
        accessToken: encryptToken("expired-access"),
        refreshToken: encryptToken("refresh-token"),
        accessTokenExpiresAt: new Date(Date.now() - 60_000),
      })
      .returning()
    if (!connection) throw new Error("missing connection")

    const calls: string[] = []
    setGoogleFetchForTest(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes("oauth2.googleapis.com/token")) {
        return okJson({ access_token: "fresh-access", expires_in: 3600 })
      }
      if (url.includes("/calendar/v3/calendars/primary/events")) {
        return okJson({
          items: [
            {
              id: "event-1",
              summary: "Planning",
              status: "confirmed",
              start: { dateTime: "2026-06-13T10:00:00Z" },
              end: { dateTime: "2026-06-13T11:00:00Z" },
              attendees: [{ email: "a@test.dev" }],
              updated: "2026-06-13T09:00:00Z",
            },
          ],
          nextSyncToken: "sync-1",
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    await syncGoogleConnection(connection.id)

    const [updated] = await db
      .select()
      .from(googleConnection)
      .where(eq(googleConnection.id, connection.id))
      .limit(1)
    expect(decryptToken(updated?.accessToken)).toBe("fresh-access")
    expect(calls.some((u) => u.includes("oauth2.googleapis.com/token"))).toBe(true)
    const [event] = await db
      .select()
      .from(googleCalendarEvent)
      .where(eq(googleCalendarEvent.googleEventId, "event-1"))
      .limit(1)
    expect(event?.summary).toBe("Planning")
    const [sync] = await db
      .select()
      .from(googleCalendarSync)
      .where(eq(googleCalendarSync.connectionId, connection.id))
      .limit(1)
    expect(sync?.syncToken).toBe("sync-1")
  })

  it("mirrors Calendar events into an Event concept (idempotent)", async () => {
    const actor = await signUpAndOrg()
    const [connection] = await db
      .insert(googleConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        scopes: GOOGLE_SCOPES.calendarEvents,
        accessToken: encryptToken("access"),
        accessTokenExpiresAt: new Date(Date.now() + 5 * 60_000),
      })
      .returning()
    if (!connection) throw new Error("missing connection")

    let title = "Planning"
    setGoogleFetchForTest(async (input) => {
      const url = String(input)
      if (url.includes("/calendar/v3/calendars/primary/events")) {
        return okJson({
          items: [
            {
              id: "event-1",
              summary: title,
              status: "confirmed",
              location: "Room A",
              start: { dateTime: "2026-06-13T10:00:00Z" },
              end: { dateTime: "2026-06-13T11:00:00Z" },
              attendees: [{ email: "a@test.dev" }],
              updated: "2026-06-13T09:00:00Z",
            },
          ],
          nextSyncToken: "sync-1",
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    await syncGoogleConnection(connection.id)

    const [conn1] = await db
      .select()
      .from(googleConnection)
      .where(eq(googleConnection.id, connection.id))
      .limit(1)
    expect(conn1?.conceptId).toBeTruthy()
    const conceptId = conn1?.conceptId as string
    const fieldMap = (conn1?.fieldMap ?? {}) as Record<string, string>
    expect(fieldMap.externalId).toBeTruthy()

    const concept = await pool.query<{ name: string }>(
      `SELECT name FROM concepts WHERE org_id = $1 AND id = $2`,
      [actor.orgId, conceptId],
    )
    expect(concept.rows[0]?.name).toBe("Google - Calendar Event")

    const fId = fieldMap.externalId as string
    const fTitle = fieldMap.title as string
    const fStarts = fieldMap.startsAt as string
    const fLocation = fieldMap.location as string

    const states1 = await instanceStates(actor.orgId, conceptId)
    expect(states1).toHaveLength(1)
    const ev = states1.find((s) => s[fId] === "event-1")
    if (!ev) throw new Error("event-1 recordVersion missing")
    expect(ev[fTitle]).toBe("Planning")
    expect(ev[fLocation]).toBe("Room A")
    expect(ev[fStarts]).toBeTruthy()
    // Raw payload / attendees are NOT written into record version fields (only typed columns).
    expect(Object.keys(ev).every((k) => Object.values(fieldMap).includes(k))).toBe(true)

    // Second sync with a changed title: same record version count, updated in place.
    title = "Replanning"
    await syncGoogleConnection(connection.id)
    const states2 = await instanceStates(actor.orgId, conceptId)
    expect(states2).toHaveLength(1)
    const ev2 = states2.find((s) => s[fId] === "event-1")
    expect(ev2?.[fTitle]).toBe("Replanning")
  })

  it("dedupes Calendar push notifications", async () => {
    const actor = await signUpAndOrg()
    const [connection] = await db
      .insert(googleConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        scopes: GOOGLE_SCOPES.calendarEvents,
        accessToken: encryptToken("access"),
        accessTokenExpiresAt: new Date(Date.now() + 5 * 60_000),
      })
      .returning()
    if (!connection) throw new Error("missing connection")
    await db.insert(googleCalendarSync).values({
      connectionId: connection.id,
      calendarId: "primary",
      watchChannelId: "channel-1",
      watchToken: "token-1",
    })

    // `beforeEach` disables sync deployment-wide so the OAuth-callback tests
    // don't call out. Push honours that same toggle now, so this test — which is
    // specifically about the push path doing work — has to turn it back on.
    delete process.env.GOOGLE_SYNC_ENABLED

    let calendarCalls = 0
    setGoogleFetchForTest(async (input) => {
      const url = String(input)
      if (url.includes("/calendar/v3/calendars/primary/events")) {
        calendarCalls += 1
        return okJson({ items: [], nextSyncToken: "sync-push" })
      }
      return new Response("unexpected", { status: 500 })
    })
    const headers = new Headers({
      "x-goog-channel-id": "channel-1",
      "x-goog-channel-token": "token-1",
      "x-goog-message-number": "99",
      "x-goog-resource-state": "exists",
    })

    const first = await handleCalendarPush(
      new Request("http://localhost/push", { method: "POST", headers }),
    )
    const second = await handleCalendarPush(
      new Request("http://localhost/push", { method: "POST", headers }),
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(calendarCalls).toBe(1)
  })
})

describe("Google connect scopes", () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "client"
    process.env.GOOGLE_CLIENT_SECRET = "secret"
    process.env.GOOGLE_REDIRECT_URI = "http://localhost/api/integrations/google/callback"
    process.env.INTEGRATION_ENCRYPTION_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  })

  afterEach(() => {
    process.env = { ...oldEnv }
  })

  const connect = async (actor: { headers: Headers }, query = "") => {
    const res = await handleGoogleConnect(
      new Request(`http://localhost/api/integrations/google/connect${query}`, {
        headers: actor.headers,
      }),
    )
    if (res.status !== 302) return { res, scopes: [] as string[], url: null }
    const url = new URL(res.headers.get("location") ?? "")
    return { res, scopes: (url.searchParams.get("scope") ?? "").split(" "), url }
  }

  const setCapabilities = async (actor: { headers: Headers }, google: string[] | null) => {
    const headers = new Headers(actor.headers)
    headers.set("content-type", "application/json")
    const res = await updateIntegrationSettings(
      new Request("http://localhost/api/integrations/settings", {
        method: "POST",
        headers,
        body: JSON.stringify({ capabilities: { google } }),
      }),
    )
    expect(res.status).toBe(200)
  }

  it("requests calendar alone by default — no Gmail scope at all", async () => {
    const actor = await signUpAndOrg()
    const { scopes, url } = await connect(actor)
    expect(scopes).toEqual([GOOGLE_SCOPES.calendarEvents])
    expect(scopes.some((s) => s.includes("gmail"))).toBe(false)
    // Reconnecting must not silently re-grant scopes the org has since turned off.
    expect(url?.searchParams.has("include_granted_scopes")).toBe(false)
  })

  it("never requests a Gmail scope: the settings API refuses it and a stored selection is ignored", async () => {
    const actor = await signUpAndOrg()
    for (const id of ["gmail.metadata", "gmail.read", "gmail.send"]) {
      const res = await updateIntegrationSettings(
        new Request("http://localhost/api/integrations/settings", {
          method: "POST",
          headers: new Headers({
            ...Object.fromEntries(actor.headers),
            "content-type": "application/json",
          }),
          body: JSON.stringify({ capabilities: { google: ["calendar", id] } }),
        }),
      )
      expect(res.status, id).toBe(400)
    }

    // A selection written before the block (straight into the table, as an older
    // build would have) cannot widen the request either.
    await db.insert(orgIntegrationSettings).values({
      orgId: actor.orgId,
      enabledCapabilities: { google: ["calendar", "gmail.metadata", "gmail.read", "gmail.send"] },
    })
    const { scopes } = await connect(actor)
    expect(scopes).toEqual([GOOGLE_SCOPES.calendarEvents])
    expect(scopes.some((s) => s.includes("gmail"))).toBe(false)
  })

  it("lets a capability param narrow the request but never widen it", async () => {
    const actor = await signUpAndOrg()
    // The param cannot pull Gmail in.
    expect((await connect(actor, "?capability=gmail.send&capability=gmail.read")).res.status).toBe(
      400,
    )
    expect((await connect(actor, "?capability=calendar")).scopes).toEqual([
      GOOGLE_SCOPES.calendarEvents,
    ])
  })

  it("refuses to connect when every capability is disabled", async () => {
    const actor = await signUpAndOrg()
    await setCapabilities(actor, [])
    const { res } = await connect(actor)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toBe("NO_CAPABILITIES_ENABLED")
  })
})

describe("Gmail is disabled", () => {
  const oldEnv = { ...process.env }
  const urls: string[] = []

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "client"
    process.env.GOOGLE_CLIENT_SECRET = "secret"
    process.env.INTEGRATION_ENCRYPTION_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    process.env.GOOGLE_SYNC_ENABLED = "1"
    process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN = "push-secret"
    process.env.GOOGLE_PUBSUB_TOPIC = "projects/p/topics/t"
    urls.length = 0
    // Calendar answers; ANY other call is recorded and fails. Every test asserts the
    // recorded list holds no Gmail URL.
    setGoogleFetchForTest(async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.includes("/calendar/v3/calendars/primary/events")) {
        return okJson({ items: [], nextSyncToken: "sync-1" })
      }
      return new Response("unexpected", { status: 500 })
    })
  })

  afterEach(() => {
    setGoogleFetchForTest(fetch)
    process.env = { ...oldEnv }
  })

  const gmailUrls = () =>
    urls.filter((u) => u.includes("/gmail/") || u.includes("gmail.googleapis"))

  /** A connection whose token still carries every Gmail scope — i.e. one made before
   *  the block. The gates must hold on the code, not on what the token happens to say. */
  const legacyConnection = async (actor: { orgId: string; userId: string }) => {
    const [connection] = await db
      .insert(googleConnection)
      .values({
        orgId: actor.orgId,
        userId: actor.userId,
        email: `legacy-${randomUUID().slice(0, 8)}@test.dev`,
        scopes: [
          GOOGLE_SCOPES.calendarEvents,
          GOOGLE_SCOPES.gmailMetadata,
          GOOGLE_SCOPES.gmailReadonly,
          GOOGLE_SCOPES.gmailSend,
        ].join(" "),
        accessToken: encryptToken("access"),
        accessTokenExpiresAt: new Date(Date.now() + 5 * 60_000),
      })
      .returning()
    if (!connection) throw new Error("missing connection")
    return connection
  }

  const jsonRequest = (actor: { headers: Headers }, url: string, method: string, body?: unknown) =>
    new Request(url, {
      method,
      headers: new Headers({
        ...Object.fromEntries(actor.headers),
        "content-type": "application/json",
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  it("sync talks to Calendar only and mirrors no mail", async () => {
    const actor = await signUpAndOrg()
    const connection = await legacyConnection(actor)

    await syncGoogleConnection(connection.id)

    expect(urls.length).toBeGreaterThan(0)
    expect(gmailUrls()).toEqual([])
    const [row] = await db
      .select()
      .from(googleConnection)
      .where(eq(googleConnection.id, connection.id))
    // No Email concept was provisioned, so nothing org-visible was created.
    expect(row?.gmailConceptId).toBeNull()
    for (const table of [googleGmailThread, googleGmailMessage, googleGmailSync]) {
      const rows = await db.select().from(table).where(eq(table.connectionId, connection.id))
      expect(rows).toHaveLength(0)
    }
  })

  it("refuses the thread list, the thread read and send with 410, calling nothing", async () => {
    const actor = await signUpAndOrg()
    await legacyConnection(actor)

    const calls = [
      await listGoogleThreads(
        jsonRequest(actor, "http://localhost/api/integrations/google/gmail/threads", "GET"),
      ),
      await getGoogleThread(
        jsonRequest(actor, "http://localhost/api/integrations/google/gmail/threads/t1", "GET"),
        "t1",
      ),
      await sendGoogleMail(
        jsonRequest(actor, "http://localhost/api/integrations/google/gmail/send", "POST", {
          to: "a@test.dev",
          subject: "hi",
          text: "body",
        }),
      ),
    ]
    for (const res of calls) {
      expect(res.status).toBe(410)
      expect(((await res.json()) as { error?: string }).error).toBe("GMAIL_DISABLED")
    }
    expect(urls).toEqual([])
  })

  it("still authenticates before refusing", async () => {
    const res = await listGoogleThreads(
      new Request("http://localhost/api/integrations/google/gmail/threads"),
    )
    expect(res.status).not.toBe(410)
    expect(res.status).toBeGreaterThanOrEqual(401)
  })

  describe("Pub/Sub push", () => {
    const push = (token: string | null, messageId: string) =>
      handleGmailPush(
        new Request(
          `http://localhost/api/integrations/google/gmail/push${token ? `?token=${token}` : ""}`,
          {
            method: "POST",
            body: JSON.stringify({
              message: {
                messageId,
                data: Buffer.from(JSON.stringify({ emailAddress: "a@test.dev" })).toString(
                  "base64url",
                ),
              },
            }),
          },
        ),
      )

    it("refuses a valid push with 410, records nothing and syncs nothing", async () => {
      const actor = await signUpAndOrg()
      const connection = await legacyConnection(actor)
      await db
        .update(googleConnection)
        .set({ email: "a@test.dev" })
        .where(eq(googleConnection.id, connection.id))
      const messageId = `m-${randomUUID()}`

      const res = await push("push-secret", messageId)

      expect(res.status).toBe(410)
      expect(urls).toEqual([])
      const dedupe = await db
        .select()
        .from(googleNotification)
        .where(eq(googleNotification.key, `gmail:${messageId}`))
      expect(dedupe).toHaveLength(0)
    })

    it("still rejects a bad token as before, rather than revealing the block", async () => {
      expect((await push("wrong", `m-${randomUUID()}`)).status).toBe(401)
      expect((await push(null, `m-${randomUUID()}`)).status).toBe(401)
    })
  })

  it("renews no Gmail watch even with a Pub/Sub topic configured", async () => {
    const actor = await signUpAndOrg()
    const connection = await legacyConnection(actor)

    // Resolves (does not throw), so the early return is what stopped it, not only the
    // transport refusing the request.
    await expect(renewWatches(connection.id)).resolves.toBeUndefined()

    expect(gmailUrls()).toEqual([])
    const rows = await db
      .select()
      .from(googleGmailSync)
      .where(eq(googleGmailSync.connectionId, connection.id))
    expect(rows).toHaveLength(0)
  })

  it("the transport refuses any Gmail URL, on either host, and still passes Calendar", async () => {
    const actor = await signUpAndOrg()
    const connection = await legacyConnection(actor)

    for (const url of [
      "https://www.googleapis.com/gmail/v1/users/me/profile",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    ]) {
      await expect(googleRequest(connection.id, url), url).rejects.toMatchObject({ status: 410 })
    }
    expect(urls).toEqual([])

    await googleRequest(
      connection.id,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    )
    expect(urls).toHaveLength(1)
  })

  it("status reports no Gmail watch", async () => {
    const actor = await signUpAndOrg()
    await legacyConnection(actor)
    const res = await googleStatus(
      jsonRequest(actor, "http://localhost/api/integrations/google/status", "GET"),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).not.toHaveProperty("gmailWatchExpiresAt")
  })
})
