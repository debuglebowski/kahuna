import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { auth } from "./auth"
import { bootstrapInitialAdmin, isEmptyDeployment, readInitialAdminEnv } from "./bootstrap"

/**
 * First-boot admin provisioning (see server/bootstrap.ts).
 *
 * The suite shares one database and is therefore never an empty deployment, so
 * the guard and the work it guards are tested separately: `isEmptyDeployment`
 * against the real DB, and `bootstrapInitialAdmin` with an explicit config —
 * which is exactly why that parameter is injectable.
 */
const ENV_KEYS = ["INITIAL_ADMIN_EMAIL", "INITIAL_ADMIN_PASSWORD", "INITIAL_ORG_NAME"] as const

describe("initial admin bootstrap", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key]
  })

  describe("env parsing", () => {
    it("is opt-in: null when neither half is set", () => {
      expect(readInitialAdminEnv()).toBeNull()
    })

    it("throws when only one half is set", () => {
      // Not null: a half-set pair is a typo, not a decision. Degrading to
      // "bootstrap not wanted" hides a mistyped key behind the same silence as an
      // untouched deployment, and the deploy then goes green with no way in.
      process.env.INITIAL_ADMIN_EMAIL = "admin@test.dev"
      expect(() => readInitialAdminEnv()).toThrow(/INITIAL_ADMIN_PASSWORD is not/)

      delete process.env.INITIAL_ADMIN_EMAIL
      process.env.INITIAL_ADMIN_PASSWORD = "password12345"
      expect(() => readInitialAdminEnv()).toThrow(/INITIAL_ADMIN_EMAIL is not/)
    })

    it("defaults the org name and trims the email", () => {
      process.env.INITIAL_ADMIN_EMAIL = "  admin@test.dev  "
      process.env.INITIAL_ADMIN_PASSWORD = "password12345"
      expect(readInitialAdminEnv()).toEqual({
        email: "admin@test.dev",
        password: "password12345",
        orgName: "Allting",
      })

      process.env.INITIAL_ORG_NAME = "Acme"
      expect(readInitialAdminEnv()?.orgName).toBe("Acme")
    })
  })

  describe("guard", () => {
    it("skips when not configured, without touching the database", async () => {
      expect(await bootstrapInitialAdmin()).toEqual({
        status: "skipped",
        reason: "not-configured",
      })
    })

    it("declines once any account exists", async () => {
      // Provision one explicitly rather than relying on another suite having run
      // first: global-setup recreates this database, so file ordering would
      // otherwise decide whether the deployment looks empty.
      const { createUserDirect } = await import("./provision")
      await createUserDirect({ email: `seed-${randomUUID()}@test.dev`, password: "password12345" })

      // The real-world "second deploy" case. The guard is 'no account has EVER
      // existed', so deleting the initial admin after handover must not
      // resurrect it on the next deploy.
      expect(await isEmptyDeployment()).toBe(false)

      expect(
        await bootstrapInitialAdmin({
          email: `never-${randomUUID()}@test.dev`,
          password: "password12345",
          orgName: "Should Not Exist",
        }),
      ).toEqual({ status: "skipped", reason: "already-provisioned" })
    })

    it("rejects a password shorter than better-auth's minimum", async () => {
      // createUserDirect writes rows directly and so never passes through the
      // route that enforces this — without the explicit check, `short` would
      // become a working owner credential.
      await expect(
        bootstrapInitialAdmin({
          email: `short-${randomUUID()}@test.dev`,
          password: "short",
          orgName: "Allting",
        }),
      ).rejects.toThrow(/at least 8 characters/)
    })
  })

  describe("the account it would create", () => {
    it("is sign-in ready and owns a seeded org", async () => {
      // Both guards are things this suite's database cannot satisfy — it has
      // accounts AND orgs — so drive the provisioning underneath them to prove
      // the resulting credential actually works. createOrganization rather than
      // createOrgDirect for the same reason every other suite does: the direct
      // helper enforces one-org-per-deployment (see the test below).
      const { createUserDirect, makeOrgSlug } = await import("./provision")
      const email = `boot-${randomUUID()}@test.dev`
      const password = "password12345"

      const created = await createUserDirect({ email, password })
      expect(created.created).toBe(true)
      // No name passed: it falls back to the email, which is why bootstrap does
      // not need an INITIAL_ADMIN_NAME variable.
      const org = await auth.api.createOrganization({
        body: {
          name: "Allting",
          slug: makeOrgSlug("Allting"),
          userId: created.userId,
        },
      })
      expect(org?.id).toBeTruthy()

      const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
      expect(res.status).toBe(200)
    })

    it("refuses a second org — one org per deployment", async () => {
      // This database already has orgs, which is exactly the condition the guard
      // fires on. It is the only thing standing between a future caller and a
      // silently multi-tenant deployment, since the HTTP endpoint is closed.
      const { createOrgDirect, createUserDirect, makeOrgSlug } = await import("./provision")
      const created = await createUserDirect({
        email: `second-${randomUUID()}@test.dev`,
        password: "password12345",
      })
      await expect(
        createOrgDirect({
          userId: created.userId,
          name: "Second Org",
          slug: makeOrgSlug("Second Org"),
        }),
      ).rejects.toThrow(/already has an organization/)
    })

    it("generates a unique slug per call from the same org name", async () => {
      const { makeOrgSlug } = await import("./provision")
      expect(makeOrgSlug("Allting")).toMatch(/^allting-[a-z0-9]{1,5}$/)
      expect(makeOrgSlug("Allting")).not.toBe(makeOrgSlug("Allting"))
      // Punctuation-only names still produce a valid slug.
      expect(makeOrgSlug("!!!")).toMatch(/^org-[a-z0-9]{1,5}$/)
    })
  })
})
