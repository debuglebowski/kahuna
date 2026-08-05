import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ConceptService, FieldService, RecordService } from "#engine"
import { auth, ORG_SCOPED_TABLES } from "./auth"
import { createUserDirect } from "./provision"
import { runEngineOrThrow, systemScope } from "./runtime"
import { seedKingsmaker } from "./seed/seed"
import { runScoped } from "./session"

/** Convert a Set-Cookie response header into a request Cookie header. */
const cookieHeader = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ")

/** Sign up a fresh user, create an org (owner), make it active. */
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
  return { headers, orgId: org.id }
}

const listConcepts = Effect.flatMap(ConceptService, (c) => c.list())

describe("tier 0 (BetterAuth) + scoping", () => {
  it("rejects an unauthenticated request (401)", async () => {
    const result = await runScoped(new Request("http://localhost/api/concepts"), listConcepts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  it("an authenticated member runs engine ops scoped to their org", async () => {
    const { headers, orgId } = await signUpAndOrg()
    await runEngineOrThrow(systemScope(orgId, "system"), seedKingsmaker)
    const req = new Request("http://localhost/api/concepts", { headers })
    const result = await runScoped(req, listConcepts)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.length).toBe(8)
  })

  it("org A cannot see org B's recordVersions (404 via session scope)", async () => {
    const a = await signUpAndOrg()
    const b = await signUpAndOrg()
    await runEngineOrThrow(systemScope(a.orgId, "system"), seedKingsmaker)
    const created = await runEngineOrThrow(
      systemScope(a.orgId, "system"),
      Effect.flatMap(RecordService, (i) => i.create({ conceptName: "Company", fields: {} })),
    )
    const reqB = new Request("http://localhost/x", { headers: b.headers })
    const res = await runScoped(
      reqB,
      Effect.flatMap(RecordService, (i) => i.get(created.id)),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(404)
  })

  it("deleting an org purges its engine data (beforeDeleteOrganization hook)", async () => {
    const { headers, orgId } = await signUpAndOrg()
    await runEngineOrThrow(systemScope(orgId, "system"), seedKingsmaker)
    await runEngineOrThrow(
      systemScope(orgId, "system"),
      Effect.flatMap(RecordService, (i) => i.create({ conceptName: "Company", fields: {} })),
    )
    const before = await runEngineOrThrow(systemScope(orgId, "system"), listConcepts)
    expect(before.length).toBe(8)

    await auth.api.deleteOrganization({ body: { organizationId: orgId }, headers })

    const after = await runEngineOrThrow(systemScope(orgId, "system"), listConcepts)
    expect(after.length).toBe(0)
  })

  it("an illegal Agreement status transition surfaces as 422 ILLEGAL_TRANSITION", async () => {
    const a = await signUpAndOrg()
    await runEngineOrThrow(systemScope(a.orgId, "system"), seedKingsmaker)
    // Resolve the seeded Agreement.status field id, then create a draft agreement.
    const { recordVersionId, statusId } = await runEngineOrThrow(
      systemScope(a.orgId, "system"),
      Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fieldSvc = yield* FieldService
        const recordVersions = yield* RecordService
        const agreement = yield* concepts.getByName("Agreement")
        const fs = yield* fieldSvc.listFields(agreement.id)
        const statusId = fs.find((f) => f.name === "status")!.id
        const inst = yield* recordVersions.create({
          conceptId: agreement.id,
          fields: { [statusId]: "draft" },
        })
        return { recordVersionId: inst.id, statusId }
      }),
    )
    const req = new Request("http://localhost/x", { headers: a.headers })
    // draft only allows -> active; jumping to "expired" is illegal.
    const res = await runScoped(
      req,
      Effect.flatMap(RecordService, (i) =>
        i.transition({ recordVersionId, expectedVersion: 0, field: statusId, to: "expired" }),
      ),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(422)
      expect(res.code).toBe("ILLEGAL_TRANSITION")
    }
  })
})

describe("org deletion purges every org-scoped table", () => {
  /**
   * THE DRIFT GUARD. `purgeOrgEngineData` names its tables explicitly, because
   * `org_id` carries no DB-level FK to the BetterAuth organization row — nothing
   * cascades. So a new org-scoped table that nobody adds to the list silently leaves
   * rows behind on every org deletion.
   *
   * That already happened twice: 22 orphaned `dashboards` and (once access control
   * landed) 28 orphaned `access_roles` with 308 orphaned `access_rules`, all belonging
   * to orgs that no longer existed. Hence this assertion rather than a comment.
   */
  it("lists exactly the tables in the schema that carry org_id", () => {
    const schema = readFileSync(path.join(import.meta.dirname, "..", "db", "schema.ts"), "utf8")
    // Each `pgTable("name", {` whose body declares an org_id column.
    const declared: string[] = []
    for (const m of schema.matchAll(/pgTable\(\s*"([a-z_]+)"\s*,\s*\{/g)) {
      const start = m.index ?? 0
      const next = schema.indexOf("pgTable(", start + 8)
      const body = schema.slice(start, next === -1 ? undefined : next)
      if (/orgId:\s*text\("org_id"\)/.test(body)) declared.push(m[1]!)
    }
    expect(declared.length).toBeGreaterThan(20)

    const missing = declared.filter((t) => !ORG_SCOPED_TABLES.includes(t))
    expect(
      missing,
      `these org-scoped tables are not purged on org deletion: ${missing.join(", ")}`,
    ).toEqual([])

    // And nothing listed that no longer exists — a stale name would throw at
    // DELETE time, aborting a deletion that should have succeeded.
    const stale = ORG_SCOPED_TABLES.filter((t) => !declared.includes(t))
    expect(stale, `purge list names tables that aren't in the schema: ${stale.join(", ")}`).toEqual(
      [],
    )
  })
})
