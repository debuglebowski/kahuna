import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { auth } from "./auth"
import {
  googleCalendarEvent,
  googleCalendarSync,
  googleConnection,
  googleOAuthState,
} from "./auth-schema"
import { db } from "./db"
import {
  decryptToken,
  encryptToken,
  GOOGLE_SCOPES,
  handleCalendarPush,
  handleGoogleCallback,
  setGoogleFetchForTest,
  syncGoogleConnection,
} from "./google"

const cookieHeader = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ")

const signUpAndOrg = async () => {
  const email = `u-${randomUUID()}@test.dev`
  const password = "password12345"
  await auth.api.signUpEmail({ body: { email, password, name: "Tester" } })
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
  const headers = new Headers({ cookie: cookieHeader(signIn) })
  const org = await auth.api.createOrganization({
    body: { name: `Org ${randomUUID().slice(0, 8)}`, slug: `org-${randomUUID().slice(0, 8)}` },
    headers,
  })
  if (!org) throw new Error("createOrganization returned null")
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers })
  const session = await auth.api.getSession({ headers })
  if (!session?.user) throw new Error("missing session")
  return { headers, orgId: org.id, userId: session.user.id }
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

describe("Google integration", () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "client"
    process.env.GOOGLE_CLIENT_SECRET = "secret"
    process.env.GOOGLE_REDIRECT_URI = "http://localhost/api/integrations/google/callback"
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY =
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
      scopes: [GOOGLE_SCOPES.calendarEvents, GOOGLE_SCOPES.gmailMetadata].join(" "),
      returnTo: "/settings/integrations",
      expiresAt: new Date(Date.now() + 60_000),
    })
    setGoogleFetchForTest(async (input) => {
      const url = String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        return okJson({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          scope: [GOOGLE_SCOPES.calendarEvents, GOOGLE_SCOPES.gmailMetadata].join(" "),
        })
      }
      if (url.includes("/gmail/v1/users/me/profile")) {
        return okJson({ emailAddress: "tester@gmail.com", historyId: "10" })
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
      .where(and(eq(googleConnection.orgId, actor.orgId), eq(googleConnection.userId, actor.userId)))
      .limit(1)
    expect(connection?.email).toBe("tester@gmail.com")
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

    const first = await handleCalendarPush(new Request("http://localhost/push", { method: "POST", headers }))
    const second = await handleCalendarPush(
      new Request("http://localhost/push", { method: "POST", headers }),
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(calendarCalls).toBe(1)
  })
})
