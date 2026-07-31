import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clayConnection, clayJob } from "#db"
import { auth } from "./auth"
import {
  clayPost,
  clayStatus,
  connectClay,
  enrichForRequest,
  handleClayCallback,
  setClayFetchForTest,
} from "./clay"
import { db } from "./db"
import { decryptToken, encryptToken } from "./integrations/crypto"
import { runEngineOrThrow } from "./runtime"
import { addField, createConcept, createInstance, getInstance, listFields } from "./use-cases"

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

const post = (path: string, actor: { headers: Headers }, body: unknown) => {
  const headers = new Headers(actor.headers)
  headers.set("content-type", "application/json")
  return new Request(`http://localhost/api/integrations/clay/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

type FieldRow = { id: string; name: string }

/** Build a fresh generic concept with three text fields; return their ids. */
const setupConcept = async (orgId: string, userId: string) => {
  const scope = { orgId, actor: userId }
  const concept = (await runEngineOrThrow(
    scope,
    createConcept(`Lead ${randomUUID().slice(0, 6)}`),
  )) as { id: string }
  for (const name of ["Email", "Title", "Company"]) {
    await runEngineOrThrow(scope, addField({ conceptId: concept.id, name, kind: "text" }))
  }
  const fields = (await runEngineOrThrow(scope, listFields(concept.id))) as ReadonlyArray<FieldRow>
  const fid = (name: string) => fields.find((f) => f.name === name)!.id
  return { scope, conceptId: concept.id, fid }
}

/** Seed a connected Clay connection directly (encrypted URL + callback secret). */
const seedConnection = async (
  orgId: string,
  userId: string,
  opts: {
    webhookUrl?: string
    secret?: string
    newRowConceptId?: string
    newRowMapping?: Record<string, string>
  } = {},
) => {
  const secret = opts.secret ?? `sek_${randomUUID()}`
  const [row] = await db
    .insert(clayConnection)
    .values({
      orgId,
      userId,
      tableWebhookUrl: encryptToken(opts.webhookUrl ?? "https://clay.test/webhook/abc"),
      callbackSecret: encryptToken(secret),
      newRowConceptId: opts.newRowConceptId ?? null,
      newRowMapping: opts.newRowMapping ?? {},
    })
    .returning()
  if (!row) throw new Error("seedConnection failed")
  return { connection: row, secret }
}

/** Build a session-less Clay → KM callback request. */
const callbackReq = (
  cid: string | null,
  token: string | null,
  body: unknown,
  opts: { headerSecret?: string } = {},
) => {
  const headers = new Headers({ "content-type": "application/json" })
  if (opts.headerSecret) headers.set("x-clay-secret", opts.headerSecret)
  const params = new URLSearchParams()
  if (cid) params.set("cid", cid)
  if (token != null) params.set("token", token)
  const qs = params.toString()
  return new Request(`http://localhost/api/integrations/clay/callback${qs ? `?${qs}` : ""}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

describe("Clay integration", () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  })

  afterEach(() => {
    setClayFetchForTest(fetch)
    process.env = { ...oldEnv }
  })

  it("round-trips an encrypted token", () => {
    const encrypted = encryptToken("https://clay.test/webhook/secret")
    expect(encrypted).not.toBe("https://clay.test/webhook/secret")
    expect(encrypted).toMatch(/^v1\./)
    expect(decryptToken(encrypted)).toBe("https://clay.test/webhook/secret")
  })

  it("clayPost retries a 429 and returns the eventual response", async () => {
    let calls = 0
    setClayFetchForTest(async () => {
      calls += 1
      if (calls === 1)
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
      return okJson({ ok: true })
    })
    const res = await clayPost("https://clay.test/webhook/abc", { hi: 1 })
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })

  it("connect stores the webhook URL encrypted and returns a callback URL", async () => {
    const actor = await signUpAndOrg()
    const res = await connectClay(
      post("connect", actor, { tableWebhookUrl: "https://clay.test/webhook/abc" }),
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.connected).toBe(true)
    expect(typeof payload.callbackUrl).toBe("string")
    expect(payload.callbackUrl).toContain("/api/integrations/clay/callback")
    expect(payload.callbackUrl).toContain("cid=")
    expect(payload.callbackUrl).toContain("token=")

    const [row] = await db
      .select()
      .from(clayConnection)
      .where(eq(clayConnection.orgId, actor.orgId))
      .limit(1)
    expect(row?.status).toBe("connected")
    expect(row?.tableWebhookUrl).not.toBe("https://clay.test/webhook/abc")
    expect(decryptToken(row?.tableWebhookUrl)).toBe("https://clay.test/webhook/abc")
    expect(decryptToken(row?.callbackSecret)).toBeTruthy()
  })

  it("rejects an invalid webhook URL with a 400", async () => {
    const actor = await signUpAndOrg()
    const res = await connectClay(post("connect", actor, { tableWebhookUrl: "not-a-url" }))
    expect(res.status).toBe(400)
    const payload = (await res.json()) as { error?: string }
    expect(payload.error).toBe("INVALID_WEBHOOK_URL")
  })

  it("status reports the connected shape with the callback URL", async () => {
    const actor = await signUpAndOrg()
    const { secret } = await seedConnection(actor.orgId, actor.userId)
    const res = await clayStatus(
      new Request("http://localhost/api/integrations/clay/status", { headers: actor.headers }),
    )
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.configured).toBe(true)
    expect(payload.connected).toBe(true)
    expect(payload.callbackUrl).toContain(`token=${encodeURIComponent(secret)}`)
    expect(payload.hasTableWebhook).toBe(true)
  })

  it("push sends a row with a correlation id and records a pending job", async () => {
    const actor = await signUpAndOrg()
    await seedConnection(actor.orgId, actor.userId)
    const { scope, conceptId, fid } = await setupConcept(actor.orgId, actor.userId)
    const emailF = fid("Email")
    const titleF = fid("Title")
    const companyF = fid("Company")
    const inst = (await runEngineOrThrow(
      scope,
      createInstance(conceptId, { [emailF]: "jane@acme.com" }),
    )) as { id: string }

    let sentBody: Record<string, unknown> | null = null
    let sentUrl = ""
    setClayFetchForTest(async (input, init) => {
      sentUrl = String(input)
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return okJson({ ok: true })
    })

    const res = await enrichForRequest(
      post("enrich", actor, {
        instanceId: inst.id,
        mapping: { email: emailF, title: titleF, company: companyF },
      }),
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { ok: boolean; jobId: string }
    expect(payload.ok).toBe(true)
    expect(payload.jobId).toBeTruthy()

    expect(sentUrl).toBe("https://clay.test/webhook/abc")
    expect(sentBody).not.toBeNull()
    const body = sentBody as unknown as Record<string, unknown>
    // Correlation id is the job id; the row is keyed by Clay column names.
    expect(body._km_correlation_id).toBe(payload.jobId)
    expect(body.email).toBe("jane@acme.com")
    // Empty fields are omitted from the row.
    expect("title" in body).toBe(false)

    const [job] = await db.select().from(clayJob).where(eq(clayJob.id, payload.jobId)).limit(1)
    expect(job?.status).toBe("pending")
    expect(job?.instanceId).toBe(inst.id)
    expect(job?.conceptId).toBe(conceptId)
  })

  it("callback matches the job and writes enriched fields back to the instance", async () => {
    const actor = await signUpAndOrg()
    const { connection, secret } = await seedConnection(actor.orgId, actor.userId)
    const { scope, conceptId, fid } = await setupConcept(actor.orgId, actor.userId)
    const emailF = fid("Email")
    const titleF = fid("Title")
    const companyF = fid("Company")
    const inst = (await runEngineOrThrow(
      scope,
      createInstance(conceptId, { [emailF]: "jane@acme.com" }),
    )) as { id: string }

    // Record a pending enrich job directly (as pushRow would).
    const [job] = await db
      .insert(clayJob)
      .values({
        orgId: actor.orgId,
        connectionId: connection.id,
        instanceId: inst.id,
        conceptId,
        mapping: { email: emailF, title: titleF, company: companyF },
        direction: "enrich",
      })
      .returning()

    const res = await handleClayCallback(
      callbackReq(connection.id, secret, {
        _km_correlation_id: job!.id,
        _km_delivery_id: "d1",
        fields: { title: "VP Sales", company: "Acme Inc" },
      }),
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { matched: boolean; updated: boolean }
    expect(payload.matched).toBe(true)
    expect(payload.updated).toBe(true)

    const updated = (await runEngineOrThrow(scope, getInstance(inst.id))) as {
      state: Record<string, unknown>
    }
    expect(updated.state[titleF]).toBe("VP Sales")
    expect(updated.state[companyF]).toBe("Acme Inc")
    expect(updated.state[emailF]).toBe("jane@acme.com")

    const [done] = await db.select().from(clayJob).where(eq(clayJob.id, job!.id)).limit(1)
    expect(done?.status).toBe("done")
    expect(done?.completedAt).toBeTruthy()
  })

  it("callback rejects a forged secret and leaves the instance untouched", async () => {
    const actor = await signUpAndOrg()
    const { connection } = await seedConnection(actor.orgId, actor.userId, {
      secret: "real-secret",
    })
    const { scope, conceptId, fid } = await setupConcept(actor.orgId, actor.userId)
    const titleF = fid("Title")
    const inst = (await runEngineOrThrow(scope, createInstance(conceptId, {}))) as { id: string }
    const [job] = await db
      .insert(clayJob)
      .values({
        orgId: actor.orgId,
        connectionId: connection.id,
        instanceId: inst.id,
        conceptId,
        mapping: { title: titleF },
      })
      .returning()

    const res = await handleClayCallback(
      callbackReq(connection.id, "wrong-secret", {
        _km_correlation_id: job!.id,
        fields: { title: "Hacked" },
      }),
    )
    expect(res.status).toBe(401)
    const payload = (await res.json()) as { error?: string }
    expect(payload.error).toBe("INVALID_SECRET")

    const after = (await runEngineOrThrow(scope, getInstance(inst.id))) as {
      state: Record<string, unknown>
    }
    expect(after.state[titleF]).toBeUndefined()
  })

  it("creates a net-new instance for an unmatched callback when configured", async () => {
    const actor = await signUpAndOrg()
    const { scope, conceptId, fid } = await setupConcept(actor.orgId, actor.userId)
    const titleF = fid("Title")
    const companyF = fid("Company")
    const { connection, secret } = await seedConnection(actor.orgId, actor.userId, {
      newRowConceptId: conceptId,
      newRowMapping: { title: titleF, company: companyF },
    })

    const res = await handleClayCallback(
      callbackReq(connection.id, secret, {
        _km_delivery_id: "net-1",
        fields: { title: "Founder", company: "NewCo" },
      }),
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { matched: boolean; created: boolean; instanceId: string }
    expect(payload.matched).toBe(false)
    expect(payload.created).toBe(true)
    expect(payload.instanceId).toBeTruthy()

    const created = (await runEngineOrThrow(scope, getInstance(payload.instanceId))) as {
      state: Record<string, unknown>
    }
    expect(created.state[titleF]).toBe("Founder")
    expect(created.state[companyF]).toBe("NewCo")
  })

  it("queues an unmatched callback for review when net-new auto-create is unconfigured", async () => {
    const actor = await signUpAndOrg()
    const { connection, secret } = await seedConnection(actor.orgId, actor.userId)
    const res = await handleClayCallback(
      callbackReq(connection.id, secret, { _km_delivery_id: "q-1", fields: { name: "Orphan" } }),
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { matched: boolean; created: boolean; queued: boolean }
    expect(payload.matched).toBe(false)
    expect(payload.created).toBe(false)
    expect(payload.queued).toBe(true)
  })

  it("dedups a repeated callback delivery", async () => {
    const actor = await signUpAndOrg()
    const { connection, secret } = await seedConnection(actor.orgId, actor.userId)
    const { scope, conceptId, fid } = await setupConcept(actor.orgId, actor.userId)
    const titleF = fid("Title")
    const inst = (await runEngineOrThrow(scope, createInstance(conceptId, {}))) as { id: string }
    const [job] = await db
      .insert(clayJob)
      .values({
        orgId: actor.orgId,
        connectionId: connection.id,
        instanceId: inst.id,
        conceptId,
        mapping: { title: titleF },
      })
      .returning()

    const body = {
      _km_correlation_id: job!.id,
      _km_delivery_id: "dup-1",
      fields: { title: "First" },
    }
    const first = await handleClayCallback(callbackReq(connection.id, secret, body))
    expect((await first.json()).updated).toBe(true)

    // Re-deliver with the same delivery id but different data → must be ignored.
    const second = await handleClayCallback(
      callbackReq(connection.id, secret, { ...body, fields: { title: "Second" } }),
    )
    const secondPayload = (await second.json()) as { deduped?: boolean }
    expect(secondPayload.deduped).toBe(true)

    const after = (await runEngineOrThrow(scope, getInstance(inst.id))) as {
      state: Record<string, unknown>
    }
    expect(after.state[titleF]).toBe("First")
  })
})
