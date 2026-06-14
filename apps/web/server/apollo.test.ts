import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  apolloRequest,
  apolloStatus,
  connectApollo,
  enrichInstanceForRequest,
  importForRequest,
  searchForRequest,
  setApolloFetchForTest,
} from "./apollo"
import { auth } from "./auth"
import { apolloConnection } from "./auth-schema"
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
  return new Request(`http://localhost/api/integrations/apollo/${path}`, {
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
  )) as {
    id: string
  }
  for (const name of ["Email", "Title", "Company"]) {
    await runEngineOrThrow(scope, addField({ conceptId: concept.id, name, kind: "text" }))
  }
  const fields = (await runEngineOrThrow(scope, listFields(concept.id))) as ReadonlyArray<FieldRow>
  const fid = (name: string) => fields.find((f) => f.name === name)!.id
  return { scope, conceptId: concept.id, fid }
}

const seedConnection = (orgId: string, userId: string, apiKey = "apk_live") =>
  db.insert(apolloConnection).values({ orgId, userId, apiKey: encryptToken(apiKey) })

describe("Apollo integration", () => {
  const oldEnv = { ...process.env }

  beforeEach(() => {
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  })

  afterEach(() => {
    setApolloFetchForTest(fetch)
    process.env = { ...oldEnv }
  })

  it("round-trips an encrypted token", () => {
    const encrypted = encryptToken("apk_super_secret")
    expect(encrypted).not.toBe("apk_super_secret")
    expect(encrypted).toMatch(/^v1\./)
    expect(decryptToken(encrypted)).toBe("apk_super_secret")
  })

  it("retries a 429 and returns the body", async () => {
    let calls = 0
    setApolloFetchForTest(async () => {
      calls += 1
      if (calls === 1)
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
      return okJson({ ok: true })
    })
    const out = await apolloRequest<{ ok: boolean }>(
      { base: "https://api.apollo.io/api/v1", apiKey: "k" },
      "/auth/health",
    )
    expect(out.ok).toBe(true)
    expect(calls).toBe(2)
  })

  it("gives up after retrying 5xx and throws with the status", async () => {
    let calls = 0
    setApolloFetchForTest(async () => {
      calls += 1
      return new Response("boom", { status: 503, headers: { "retry-after": "0" } })
    })
    await expect(
      apolloRequest({ base: "https://api.apollo.io/api/v1", apiKey: "k" }, "/auth/health"),
    ).rejects.toThrow(/Apollo API 503/)
    expect(calls).toBe(4) // initial + 3 retries
  })

  it("connect validates the key (X-Api-Key) and stores it encrypted", async () => {
    const actor = await signUpAndOrg()
    const seen: string[] = []
    setApolloFetchForTest(async (input, init) => {
      const u = String(input)
      seen.push(u)
      if (u.endsWith("/auth/health")) {
        expect(new Headers(init?.headers).get("x-api-key")).toBe("apk_live")
        return okJson({ is_logged_in: true })
      }
      return new Response("unexpected", { status: 500 })
    })

    const res = await connectApollo(post("connect", actor, { apiKey: "apk_live" }))
    expect(res.status).toBe(200)
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.connected).toBe(true)
    expect(Array.isArray(payload.enrichmentFields)).toBe(true)
    expect(seen.some((u) => u.endsWith("/auth/health"))).toBe(true)

    const [row] = await db
      .select()
      .from(apolloConnection)
      .where(eq(apolloConnection.orgId, actor.orgId))
      .limit(1)
    expect(row?.status).toBe("connected")
    expect(row?.apiKey).not.toBe("apk_live")
    expect(decryptToken(row?.apiKey)).toBe("apk_live")
    expect(row?.lastValidatedAt).toBeTruthy()
  })

  it("rejects a bad key with a 400", async () => {
    const actor = await signUpAndOrg()
    setApolloFetchForTest(async () => new Response("unauthorized", { status: 401 }))
    const res = await connectApollo(post("connect", actor, { apiKey: "apk_bad" }))
    expect(res.status).toBe(400)
    const payload = (await res.json()) as { error?: string }
    expect(payload.error).toBe("INVALID_API_KEY")
  })

  it("status reports the connected shape with the enrichment catalog", async () => {
    const actor = await signUpAndOrg()
    await seedConnection(actor.orgId, actor.userId)
    const res = await apolloStatus(
      new Request("http://localhost/api/integrations/apollo/status", { headers: actor.headers }),
    )
    const payload = (await res.json()) as Record<string, unknown>
    expect(payload.configured).toBe(true)
    expect(payload.connected).toBe(true)
    expect((payload.enrichmentFields as unknown[]).length).toBeGreaterThan(0)
  })

  it("enriches empty fields via the field-id mapping, leaving populated ones intact", async () => {
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

    setApolloFetchForTest(async (input, init) => {
      const u = String(input)
      if (u.endsWith("/people/match")) {
        expect(new Headers(init?.headers).get("x-api-key")).toBe("apk_live")
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        // The lookup is DERIVED from the instance's mapped email field.
        expect(body.email).toBe("jane@acme.com")
        return okJson({
          person: {
            id: "p1",
            first_name: "Jane",
            last_name: "Doe",
            title: "VP Sales",
            email: "jane@acme.com",
            organization: { name: "Acme Inc", primary_domain: "acme.com" },
          },
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    const res = await enrichInstanceForRequest(
      post("enrich", actor, {
        instanceId: inst.id,
        mapping: { email: emailF, title: titleF, organizationName: companyF },
      }),
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { updated: boolean; fields: string[] }
    expect(payload.updated).toBe(true)
    expect(payload.fields).toContain(titleF)
    expect(payload.fields).toContain(companyF)
    expect(payload.fields).not.toContain(emailF) // already populated → not overwritten

    const updated = (await runEngineOrThrow(scope, getInstance(inst.id))) as {
      state: Record<string, unknown>
    }
    expect(updated.state[titleF]).toBe("VP Sales")
    expect(updated.state[companyF]).toBe("Acme Inc")
    expect(updated.state[emailF]).toBe("jane@acme.com")
  })

  it("overwrites populated fields when overwrite=true", async () => {
    const actor = await signUpAndOrg()
    await seedConnection(actor.orgId, actor.userId)
    const { scope, conceptId, fid } = await setupConcept(actor.orgId, actor.userId)
    const emailF = fid("Email")
    const titleF = fid("Title")
    const inst = (await runEngineOrThrow(
      scope,
      createInstance(conceptId, { [emailF]: "bob@beta.com", [titleF]: "Old Title" }),
    )) as { id: string }

    setApolloFetchForTest(async () =>
      okJson({ person: { title: "New Title", email: "bob@beta.com" } }),
    )

    const res = await enrichInstanceForRequest(
      post("enrich", actor, {
        instanceId: inst.id,
        mapping: { email: emailF, title: titleF },
        overwrite: true,
      }),
    )
    expect(res.status).toBe(200)
    const updated = (await runEngineOrThrow(scope, getInstance(inst.id))) as {
      state: Record<string, unknown>
    }
    expect(updated.state[titleF]).toBe("New Title")
  })

  it("serves a repeated lookup from cache without re-calling Apollo", async () => {
    const actor = await signUpAndOrg()
    await seedConnection(actor.orgId, actor.userId)
    const { scope, conceptId, fid } = await setupConcept(actor.orgId, actor.userId)
    const emailF = fid("Email")
    const titleF = fid("Title")
    const mk = async () =>
      (
        (await runEngineOrThrow(scope, createInstance(conceptId, { [emailF]: "dup@x.com" }))) as {
          id: string
        }
      ).id

    const a = await mk()
    const b = await mk()
    let matchCalls = 0
    setApolloFetchForTest(async (input) => {
      if (String(input).endsWith("/people/match")) {
        matchCalls += 1
        return okJson({ person: { title: "Engineer", email: "dup@x.com" } })
      }
      return new Response("unexpected", { status: 500 })
    })

    await enrichInstanceForRequest(
      post("enrich", actor, { instanceId: a, mapping: { email: emailF, title: titleF } }),
    )
    const second = await enrichInstanceForRequest(
      post("enrich", actor, { instanceId: b, mapping: { email: emailF, title: titleF } }),
    )
    const payload = (await second.json()) as { cached?: boolean; updated: boolean }
    expect(matchCalls).toBe(1) // second lookup served from cache
    expect(payload.cached).toBe(true)
    expect(payload.updated).toBe(true)
  })

  it("searches people and normalizes the results", async () => {
    const actor = await signUpAndOrg()
    await seedConnection(actor.orgId, actor.userId)
    setApolloFetchForTest(async (input, init) => {
      const u = String(input)
      if (u.endsWith("/mixed_people/search")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body.person_titles).toEqual(["VP Sales"])
        return okJson({
          people: [
            {
              id: "p1",
              first_name: "Jane",
              last_name: "Doe",
              title: "VP Sales",
              organization: { name: "Acme", primary_domain: "acme.com" },
            },
          ],
          pagination: { page: 1, per_page: 25, total_entries: 1, total_pages: 1 },
        })
      }
      return new Response("unexpected", { status: 500 })
    })

    const res = await searchForRequest(post("search", actor, { titles: ["VP Sales"] }))
    expect(res.status).toBe(200)
    const payload = (await res.json()) as {
      people: Array<Record<string, unknown>>
      pagination: { totalEntries?: number } | null
    }
    expect(payload.people).toHaveLength(1)
    expect(payload.people[0]?.name).toBe("Jane Doe")
    expect(payload.people[0]?.organizationName).toBe("Acme")
    expect(payload.people[0]?.organizationDomain).toBe("acme.com")
    expect(payload.pagination?.totalEntries).toBe(1)
  })

  it("imports normalized people as new instances via the mapping (skips unmapped)", async () => {
    const actor = await signUpAndOrg()
    await seedConnection(actor.orgId, actor.userId)
    const { scope, conceptId, fid } = await setupConcept(actor.orgId, actor.userId)
    const titleF = fid("Title")
    const companyF = fid("Company")

    const res = await importForRequest(
      post("import", actor, {
        conceptId,
        mapping: { title: titleF, organizationName: companyF },
        people: [
          { title: "VP Sales", organizationName: "Acme" },
          { firstName: "Lonely" }, // no mapped non-empty field → skipped
        ],
      }),
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { created: string[]; skipped: number }
    expect(payload.created).toHaveLength(1)
    expect(payload.skipped).toBe(1)

    const created = (await runEngineOrThrow(scope, getInstance(payload.created[0]!))) as {
      state: Record<string, unknown>
    }
    expect(created.state[titleF]).toBe("VP Sales")
    expect(created.state[companyF]).toBe("Acme")
  })
})
