import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { ssoProvider } from "#db"
import { auth } from "./auth"
import { db } from "./db"
import { createUserDirect } from "./provision"

/** The plugin only ever sees plaintext; the column only ever holds ciphertext. */

const cfg = (secret: string) => JSON.stringify({ clientId: "cid", clientSecret: secret })

const setup = async () => {
  const { userId } = await createUserDirect({
    email: `u-${randomUUID()}@test.dev`,
    password: "password12345",
    name: "Tester",
  })
  const org = await auth.api.createOrganization({
    body: { name: "O", slug: `o-${randomUUID().slice(0, 8)}`, userId },
  })
  const ctx = await auth.$context
  return { userId, orgId: org!.id, adapter: ctx.adapter }
}

const rawConfig = async (id: string) => {
  const [row] = await db.select().from(ssoProvider).where(eq(ssoProvider.id, id))
  return JSON.parse(row!.oidcConfig!) as { clientId: string; clientSecret: string }
}

describe("SSO client secret at rest", () => {
  beforeAll(() => {
    process.env.INTEGRATION_ENCRYPTION_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  })

  it("is ciphertext in the column, plaintext through the adapter", async () => {
    const { userId, orgId, adapter } = await setup()
    const created = await adapter.create<Record<string, any>>({
      model: "ssoProvider",
      data: {
        issuer: "https://idp.test.dev",
        domain: "a.test",
        oidcConfig: cfg("hunter2"),
        userId,
        providerId: `org-${orgId}`,
        organizationId: orgId,
      },
    })
    // The adapter assigns its own id; use the one it returned.
    const id = created.id as string
    expect(JSON.parse(created.oidcConfig).clientSecret).toBe("hunter2")

    const raw = await rawConfig(id)
    expect(raw.clientId).toBe("cid")
    expect(raw.clientSecret).toMatch(/^v1\./)
    expect(raw.clientSecret).not.toContain("hunter2")

    const found = await adapter.findOne<Record<string, any>>({
      model: "ssoProvider",
      where: [{ field: "id", value: id }],
    })
    expect(JSON.parse(found!.oidcConfig).clientSecret).toBe("hunter2")
    const many = await adapter.findMany<Record<string, any>>({
      model: "ssoProvider",
      where: [{ field: "providerId", value: `org-${orgId}` }],
    })
    expect(JSON.parse(many[0]!.oidcConfig).clientSecret).toBe("hunter2")

    await adapter.update({
      model: "ssoProvider",
      where: [{ field: "id", value: id }],
      update: { oidcConfig: cfg("rotated") },
    })
    const after = await rawConfig(id)
    expect(after.clientSecret).toMatch(/^v1\./)
    expect(after.clientSecret).not.toBe(raw.clientSecret)
  })

  it("still reads a legacy plaintext row", async () => {
    const { userId, orgId, adapter } = await setup()
    const id = randomUUID()
    await db.insert(ssoProvider).values({
      id,
      issuer: "https://idp.test.dev",
      domain: "b.test",
      oidcConfig: cfg("legacy"),
      userId,
      providerId: `org-${orgId}`,
      organizationId: orgId,
    })
    const found = await adapter.findOne<Record<string, any>>({
      model: "ssoProvider",
      where: [{ field: "id", value: id }],
    })
    expect(JSON.parse(found!.oidcConfig).clientSecret).toBe("legacy")
  })
})
