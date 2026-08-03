import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { posthogConnection, posthogWebhookEvent } from "#db"
import { auth } from "./auth"
import { db } from "./db"
import {
  clearIntegrationSettingsCacheForTest,
  deploymentDefaults,
  integrationSettingsStatus,
  readIntegrationOverrides,
  readIntegrationSettings,
  updateIntegrationSettings,
  writeIntegrationSettings,
} from "./integrationSettings"
import { encryptToken } from "./integrations/crypto"
import { handlePosthogWebhook, setPosthogFetchForTest, syncPosthogForRequest } from "./posthog"
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
  return { headers, orgId: org.id, userId: created.userId }
}

const addPlainMember = async (orgId: string) => {
  const email = `u-${randomUUID()}@test.dev`
  const password = "password12345"
  const created = await createUserDirect({ email, password, name: "Member" })
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
  const headers = new Headers({ cookie: cookieHeader(signIn) })
  await auth.api.addMember({
    body: { userId: created.userId, role: "member", organizationId: orgId },
  })
  await auth.api.setActiveOrganization({ body: { organizationId: orgId }, headers })
  return { headers }
}

const get = (actor: { headers: Headers }) =>
  integrationSettingsStatus(
    new Request("http://localhost/api/integrations/settings", { headers: actor.headers }),
  )

const post = (actor: { headers: Headers }, body: unknown) => {
  const headers = new Headers(actor.headers)
  headers.set("content-type", "application/json")
  return updateIntegrationSettings(
    new Request("http://localhost/api/integrations/settings", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  )
}

describe("integration settings", () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    clearIntegrationSettingsCacheForTest()
    for (const k of [
      "GOOGLE_SYNC_ENABLED",
      "GOOGLE_WATCH_ENABLED",
      "SLACK_SYNC_ENABLED",
      "POSTHOG_SYNC_ENABLED",
      "LINEAR_SYNC_ENABLED",
      "APOLLO_ENRICH_CACHE_ENABLED",
      "APOLLO_ENRICH_CACHE_TTL_DAYS",
      "ANALYTICS_CACHE_TTL_MS",
    ]) {
      delete process.env[k]
    }
  })

  afterEach(() => {
    setPosthogFetchForTest(fetch)
    process.env = { ...oldEnv }
    clearIntegrationSettingsCacheForTest()
  })

  describe("deployment defaults", () => {
    it("keeps each var's polarity: five opt-out, GOOGLE_WATCH_ENABLED opt-in", () => {
      const d = deploymentDefaults()
      expect(d.googleSyncEnabled).toBe(true)
      expect(d.slackSyncEnabled).toBe(true)
      expect(d.posthogSyncEnabled).toBe(true)
      expect(d.linearSyncEnabled).toBe(true)
      expect(d.apolloEnrichCacheEnabled).toBe(true)
      // The odd one out — opt-in, so unset means OFF.
      expect(d.googleWatchEnabled).toBe(false)
      expect(d.apolloEnrichCacheTtlDays).toBe(30)
      expect(d.analyticsCacheTtlMs).toBe(60_000)
    })

    it("honours the sentinels the code actually checks", () => {
      process.env.GOOGLE_SYNC_ENABLED = "0"
      process.env.GOOGLE_WATCH_ENABLED = "1"
      const d = deploymentDefaults()
      expect(d.googleSyncEnabled).toBe(false)
      expect(d.googleWatchEnabled).toBe(true)

      // Anything that isn't the sentinel leaves the default in place — note
      // `.env.production.example` documents `=true`, which the code never read.
      process.env.GOOGLE_SYNC_ENABLED = "true"
      process.env.GOOGLE_WATCH_ENABLED = "true"
      const d2 = deploymentDefaults()
      expect(d2.googleSyncEnabled).toBe(true)
      expect(d2.googleWatchEnabled).toBe(false)
    })

    // Regression: `Number(process.env.X ?? 60_000)` made a typo produce NaN, so
    // every `elapsed < NaN` compared false and the cache was silently off.
    it("falls back on a non-numeric TTL instead of yielding NaN", () => {
      process.env.ANALYTICS_CACHE_TTL_MS = "abc"
      process.env.APOLLO_ENRICH_CACHE_TTL_DAYS = "not-a-number"
      const d = deploymentDefaults()
      expect(d.analyticsCacheTtlMs).toBe(60_000)
      expect(d.apolloEnrichCacheTtlDays).toBe(30)
    })

    it("keeps ANALYTICS_CACHE_TTL_MS=0 meaning 'no caching'", () => {
      process.env.ANALYTICS_CACHE_TTL_MS = "0"
      expect(deploymentDefaults().analyticsCacheTtlMs).toBe(0)
      // Apollo's floor is 1 day — 0 there is out of range, so it inherits.
      process.env.APOLLO_ENRICH_CACHE_TTL_DAYS = "0"
      expect(deploymentDefaults().apolloEnrichCacheTtlDays).toBe(30)
    })
  })

  describe("resolution", () => {
    it("an org with no row gets the deployment defaults", async () => {
      const actor = await signUpAndOrg()
      process.env.LINEAR_SYNC_ENABLED = "0"
      expect(await readIntegrationSettings(actor.orgId)).toEqual(deploymentDefaults())
      expect((await readIntegrationSettings(actor.orgId)).linearSyncEnabled).toBe(false)
    })

    /**
     * The reason every column is nullable. With `NOT NULL DEFAULT true`, writing
     * ONE toggle would materialize the row and its defaults would silently
     * override the env for the other seven — so a deployment shipping
     * GOOGLE_SYNC_ENABLED=0 would see Google sync switch itself back on the
     * first time an admin touched the Linear card.
     */
    it("an override on one setting leaves the other seven inheriting env", async () => {
      const actor = await signUpAndOrg()
      process.env.GOOGLE_SYNC_ENABLED = "0"
      process.env.APOLLO_ENRICH_CACHE_TTL_DAYS = "7"

      await writeIntegrationSettings(actor.orgId, { linearSyncEnabled: false })

      const s = await readIntegrationSettings(actor.orgId)
      expect(s.linearSyncEnabled).toBe(false)
      expect(s.googleSyncEnabled).toBe(false) // still from env, not re-enabled
      expect(s.apolloEnrichCacheTtlDays).toBe(7)
      expect(s.slackSyncEnabled).toBe(true)
    })

    it("null clears an override back to inheriting", async () => {
      const actor = await signUpAndOrg()
      await writeIntegrationSettings(actor.orgId, { posthogSyncEnabled: false })
      expect((await readIntegrationSettings(actor.orgId)).posthogSyncEnabled).toBe(false)

      await writeIntegrationSettings(actor.orgId, { posthogSyncEnabled: null })
      expect((await readIntegrationSettings(actor.orgId)).posthogSyncEnabled).toBe(true)
      expect((await readIntegrationOverrides(actor.orgId)).posthogSyncEnabled).toBeNull()
    })

    it("an override can turn ON a setting the deployment defaults off", async () => {
      const actor = await signUpAndOrg()
      expect((await readIntegrationSettings(actor.orgId)).googleWatchEnabled).toBe(false)
      await writeIntegrationSettings(actor.orgId, { googleWatchEnabled: true })
      expect((await readIntegrationSettings(actor.orgId)).googleWatchEnabled).toBe(true)
    })

    it("clamps an out-of-range stored TTL back to the default", async () => {
      const actor = await signUpAndOrg()
      await writeIntegrationSettings(actor.orgId, { apolloEnrichCacheTtlDays: -5 })
      expect((await readIntegrationSettings(actor.orgId)).apolloEnrichCacheTtlDays).toBe(30)
    })
  })

  /**
   * The connector suites suppress network sync by setting `*_SYNC_ENABLED = "0"`
   * in `beforeEach`. That only works because the memo caches the org ROW and the
   * defaults are recomputed per call. Memoize the defaults and the whole
   * integration suite quietly becomes a live-network suite — failing in CI as
   * unrelated-looking timeouts. This test is the tripwire.
   */
  it("re-reads env on every call, even with the row memo warm", async () => {
    const actor = await signUpAndOrg()
    expect((await readIntegrationSettings(actor.orgId)).slackSyncEnabled).toBe(true)

    process.env.SLACK_SYNC_ENABLED = "0"
    // Deliberately NOT clearing the cache.
    expect((await readIntegrationSettings(actor.orgId)).slackSyncEnabled).toBe(false)
  })

  it("a write invalidates the memo in-process", async () => {
    const actor = await signUpAndOrg()
    expect((await readIntegrationSettings(actor.orgId)).googleSyncEnabled).toBe(true)
    await writeIntegrationSettings(actor.orgId, { googleSyncEnabled: false })
    expect((await readIntegrationSettings(actor.orgId)).googleSyncEnabled).toBe(false)
  })

  describe("endpoints", () => {
    it("GET is member-readable and reports canEdit", async () => {
      const owner = await signUpAndOrg()
      const member = await addPlainMember(owner.orgId)

      const asOwner = (await (await get(owner)).json()) as { canEdit: boolean; effective: unknown }
      expect(asOwner.canEdit).toBe(true)
      expect(asOwner.effective).toEqual(deploymentDefaults())

      const asMember = (await (await get(member)).json()) as { canEdit: boolean }
      expect(asMember.canEdit).toBe(false)
    })

    it("POST is admin-only", async () => {
      const owner = await signUpAndOrg()
      const member = await addPlainMember(owner.orgId)

      const denied = await post(member, { linearSyncEnabled: false })
      expect(denied.status).toBe(403)
      // The member's attempt wrote nothing.
      expect((await readIntegrationSettings(owner.orgId)).linearSyncEnabled).toBe(true)

      expect((await post(owner, { linearSyncEnabled: false })).status).toBe(200)
      expect((await readIntegrationSettings(owner.orgId)).linearSyncEnabled).toBe(false)
    })

    it("rejects wrong types, out-of-range numbers, and empty patches", async () => {
      const owner = await signUpAndOrg()

      expect((await post(owner, { linearSyncEnabled: "no" })).status).toBe(400)
      expect((await post(owner, { apolloEnrichCacheTtlDays: 0 })).status).toBe(400)
      expect((await post(owner, { apolloEnrichCacheTtlDays: 1.5 })).status).toBe(400)
      expect((await post(owner, { analyticsCacheTtlMs: -1 })).status).toBe(400)
      expect((await post(owner, {})).status).toBe(400)
      expect((await post(owner, { somethingElse: true })).status).toBe(400)

      // analyticsCacheTtlMs = 0 is valid ("don't cache"), unlike the Apollo TTL.
      expect((await post(owner, { analyticsCacheTtlMs: 0 })).status).toBe(200)
    })

    it("a patch touches only the keys it names, and both toggles land", async () => {
      const owner = await signUpAndOrg()
      await post(owner, { googleSyncEnabled: false, googleWatchEnabled: true })
      await post(owner, { linearSyncEnabled: false })

      const o = await readIntegrationOverrides(owner.orgId)
      expect(o.googleSyncEnabled).toBe(false)
      expect(o.googleWatchEnabled).toBe(true)
      expect(o.linearSyncEnabled).toBe(false)
      expect(o.slackSyncEnabled).toBeNull()
    })
  })

  /**
   * The toggles used to gate the connect-time backfill ONLY — webhooks and the
   * manual Sync button ignored them entirely, so "sync disabled" was never true
   * of a connected org. These pin the two paths that changed.
   */
  describe("enforcement", () => {
    const connectPosthogRow = async (orgId: string, userId: string, webhookToken: string) => {
      await db.insert(posthogConnection).values({
        orgId,
        userId,
        host: "https://us.posthog.com",
        region: "us",
        projectId: "1",
        projectName: "Test",
        apiKey: encryptToken("phx_key"),
        webhookToken,
      })
    }

    it("manual sync is refused when the org has sync off, without calling the provider", async () => {
      const actor = await signUpAndOrg()
      await connectPosthogRow(actor.orgId, actor.userId, `wh-${randomUUID()}`)
      await writeIntegrationSettings(actor.orgId, { posthogSyncEnabled: false })

      const seen: string[] = []
      setPosthogFetchForTest(async (input) => {
        seen.push(String(input))
        return new Response("{}", { headers: { "content-type": "application/json" } })
      })

      const res = await syncPosthogForRequest(
        new Request("http://localhost/api/integrations/posthog/sync", {
          method: "POST",
          headers: actor.headers,
        }),
      )
      expect(res.status).toBe(403)
      expect((await res.json()) as { error?: string }).toMatchObject({ error: "SYNC_DISABLED" })
      // The status code alone would pass even if the gate ran too late.
      expect(seen).toHaveLength(0)
    })

    it("a webhook for a disabled org is accepted but ingests nothing", async () => {
      const actor = await signUpAndOrg()
      const token = `wh-${randomUUID()}`
      await connectPosthogRow(actor.orgId, actor.userId, token)
      await writeIntegrationSettings(actor.orgId, { posthogSyncEnabled: false })

      const res = await handlePosthogWebhook(
        new Request("http://localhost/api/integrations/posthog/webhook", {
          method: "POST",
          headers: { "content-type": "application/json", "x-km-webhook-token": token },
          body: JSON.stringify({ event: { event: "signed_up", distinct_id: "u1", uuid: "e-1" } }),
        }),
      )

      // 200, not 4xx: PostHog disables destinations that keep failing, and a
      // toggle must not brick a registration the admin then has to rebuild.
      expect(res.status).toBe(200)
      const rows = await db
        .select()
        .from(posthogWebhookEvent)
        .where(eq(posthogWebhookEvent.orgId, actor.orgId))
      // Nothing recorded — and specifically no dedupe key burned, so the same
      // delivery replayed after re-enabling is still processed.
      expect(rows).toHaveLength(0)
    })

    it("a bad token still fails for a disabled org — the gate is not an auth bypass", async () => {
      const actor = await signUpAndOrg()
      await connectPosthogRow(actor.orgId, actor.userId, `wh-${randomUUID()}`)
      await writeIntegrationSettings(actor.orgId, { posthogSyncEnabled: false })

      const res = await handlePosthogWebhook(
        new Request("http://localhost/api/integrations/posthog/webhook", {
          method: "POST",
          headers: { "content-type": "application/json", "x-km-webhook-token": "not-a-token" },
          body: "{}",
        }),
      )
      expect(res.status).toBe(403)
      expect((await res.json()) as { error?: string }).toMatchObject({ error: "BAD_TOKEN" })
    })
  })
})
