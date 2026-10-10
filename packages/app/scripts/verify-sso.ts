/**
 * End-to-end verification of OIDC SSO against a RUNNING server, using the local
 * fake IdP (`fake-idp.ts`).
 *
 * What it proves:
 *   1. An owner can register the provider; the client secret is never returned.
 *   2. At rest, `oidc_config.clientSecret` is `v1.…` ciphertext, not plaintext.
 *   3. The server still presents the PLAINTEXT secret at the IdP's token endpoint
 *      (the adapter decrypts on read), and the sign-in completes with a session.
 *
 * The server must trust the IdP: start it with the env `fake-idp.ts` prints
 * (NODE_EXTRA_CA_CERTS + TRUSTED_ORIGINS). Writes to the database the server
 * uses, like the other verify drivers.
 */

import { readFileSync } from "node:fs"
import { pool } from "../server/db"
import { DEFAULT_IDP_PORT, startFakeIdp } from "./fake-idp"
import { provisionVerifyIdentity } from "./verify-session"

const API = process.env.API ?? "http://localhost:3199"
const ORIGIN = process.env.ORIGIN ?? "http://localhost:5199"
const DOMAIN = "example.test"

let failures = 0
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`)
  if (!cond) failures++
}

const cookiesFrom = (res: Response): string[] =>
  (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0] ?? "").filter(Boolean)

const post = (path: string, body: unknown, cookie = "") =>
  fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    redirect: "manual",
  })

const main = async () => {
  const idp = await startFakeIdp(Number(process.env.IDP_PORT ?? DEFAULT_IDP_PORT))
  try {
    const owner = await provisionVerifyIdentity("sso")

    const signIn = await post("/api/auth/sign-in/email", {
      email: owner.email,
      password: owner.password,
    })
    if (!signIn.ok) throw new Error(`owner sign-in failed (${signIn.status})`)
    const ownerCookie = cookiesFrom(signIn).join("; ")
    const act = await post(
      "/api/auth/organization/set-active",
      { organizationId: owner.orgId },
      ownerCookie,
    )
    if (!act.ok) throw new Error(`set-active failed (${act.status})`)

    const clientId = `verify-${Date.now()}`
    const clientSecret = `secret-${Math.random().toString(36).slice(2)}-${Date.now()}`

    const reg = await post(
      "/api/auth-config/sso",
      { issuer: idp.issuer, domain: DOMAIN, clientId, clientSecret },
      ownerCookie,
    )
    const regText = await reg.text()
    if (!reg.ok) {
      console.log(`register failed (${reg.status}): ${regText}`)
      console.log(
        `Is the server started with NODE_EXTRA_CA_CERTS=${idp.certPath} TRUSTED_ORIGINS=${idp.issuer} ?`,
      )
      failures++
      return
    }
    ok("provider registered", true)
    ok("register response omits the secret", !regText.includes(clientSecret))

    const status = await fetch(`${API}/api/auth-config/sso`, { headers: { cookie: ownerCookie } })
    const statusText = await status.text()
    ok("settings read omits the secret", !statusText.includes(clientSecret))
    ok("settings read reports hasSecret", statusText.includes('"hasSecret":true'))

    const providerId = (JSON.parse(regText) as { provider: { providerId: string } }).provider
      .providerId
    const { rows } = await pool.query<{ oidc_config: string }>(
      "select oidc_config from bauth_sso_provider where provider_id = $1",
      [providerId],
    )
    const stored = JSON.parse(rows[0]?.oidc_config ?? "{}") as { clientSecret?: string }
    ok("secret at rest is ciphertext", Boolean(stored.clientSecret?.startsWith("v1.")))
    ok("plaintext absent from stored row", !(rows[0]?.oidc_config ?? "").includes(clientSecret))

    const enable = await post(
      "/api/auth-config/methods",
      { passwordEnabled: true, ssoEnabled: true },
      ownerCookie,
    )
    ok("SSO enabled", enable.ok, `${enable.status}`)

    // The SSO user is a new identity on the provider's domain.
    const ssoEmail = `sso-user-${Date.now()}@${DOMAIN}`
    idp.setIdentity({ sub: `sub-${Date.now()}`, email: ssoEmail })

    const start = await post("/api/auth/sign-in/sso", { providerId, callbackURL: `${ORIGIN}/` })
    const startBody = (await start.json().catch(() => ({}))) as { url?: string }
    ok("sign-in/sso returns the IdP url", Boolean(startBody.url), `${start.status}`)
    if (!startBody.url) return
    const jar = cookiesFrom(start).join("; ")

    // IdP authorize auto-approves and redirects to the server's callback.
    const authz = await fetch(startBody.url, {
      redirect: "manual",
      // Bun-only option: trust the fake IdP's self-signed cert for this call.
      tls: { ca: readFileSync(idp.certPath, "utf8") },
    } as RequestInit)
    const callback = authz.headers.get("location")
    ok("IdP redirects back with a code", Boolean(callback), `${authz.status}`)
    if (!callback) return
    const cb = new URL(callback)
    const done = await fetch(`${API}${cb.pathname}${cb.search}`, {
      headers: { cookie: jar, origin: ORIGIN },
      redirect: "manual",
    })
    const sessionCookie = cookiesFrom(done).join("; ")
    ok("callback sets a session", sessionCookie.includes("session_token"), `${done.status}`)

    const tokenReq = idp.tokenRequests.at(-1)
    ok("IdP got a token request", Boolean(tokenReq))
    ok("server presented the PLAINTEXT secret", tokenReq?.clientSecret === clientSecret)
    ok("server presented the client id", tokenReq?.clientId === clientId)

    const me = await fetch(`${API}/api/auth/get-session`, { headers: { cookie: sessionCookie } })
    const meBody = (await me.json().catch(() => null)) as { user?: { email?: string } } | null
    ok("session belongs to the SSO identity", meBody?.user?.email === ssoEmail)

    // Leave the org without a provider, and password sign-in on.
    await fetch(`${API}/api/auth-config/sso`, {
      method: "DELETE",
      headers: { cookie: ownerCookie, origin: ORIGIN },
    })
  } finally {
    await idp.close()
    await pool.end()
  }
}

await main()
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
