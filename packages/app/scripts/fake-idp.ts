import { execFileSync } from "node:child_process"
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A minimal OIDC provider for driving SSO end to end against a running server.
 *
 * Generic on purpose: discovery, JWKS, authorize (auto-approves), token and
 * userinfo, with an ephemeral RS256 key. It serves HTTPS because the SSO
 * settings reject any other issuer scheme, with a self-signed cert generated
 * once into a temp dir.
 *
 * The server under test must trust that cert and the issuer origin, so start it
 * with:
 *   NODE_EXTRA_CA_CERTS=<certPath>  TRUSTED_ORIGINS=<issuer>
 * (`bun scripts/fake-idp.ts` prints both.)
 *
 * It records every token request, so a driver can assert which client secret the
 * server actually presented.
 */

export interface TokenRequest {
  readonly clientId: string
  readonly clientSecret: string
  readonly code: string
}

export interface FakeIdp {
  readonly issuer: string
  readonly certPath: string
  readonly tokenRequests: readonly TokenRequest[]
  /** Identity returned for the next sign-in. */
  setIdentity(identity: { sub: string; email: string; name?: string }): void
  close(): Promise<void>
}

export const DEFAULT_IDP_PORT = 9443

const certDir = join(tmpdir(), "kahuna-fake-idp")

/** Self-signed cert for `localhost`, created on first use and reused after. */
export const ensureCert = (): { keyPath: string; certPath: string } => {
  const keyPath = join(certDir, "key.pem")
  const certPath = join(certDir, "cert.pem")
  if (existsSync(keyPath) && existsSync(certPath)) return { keyPath, certPath }
  mkdirSync(certDir, { recursive: true })
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "30",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  )
  return { keyPath, certPath }
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url")

export const startFakeIdp = async (port = DEFAULT_IDP_PORT): Promise<FakeIdp> => {
  const { keyPath, certPath } = ensureCert()
  const { readFileSync } = await import("node:fs")
  const issuer = `https://localhost:${port}`
  const kid = randomBytes(6).toString("hex")
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }

  let identity = { sub: "fake-user", email: "user@example.test", name: "Fake User" }
  const tokenRequests: TokenRequest[] = []
  // code -> { nonce, clientId }
  const codes = new Map<string, { nonce?: string; clientId: string }>()

  const sign = (claims: Record<string, unknown>): string => {
    const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid }))
    const body = b64u(JSON.stringify(claims))
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey)
    return `${head}.${body}.${b64u(sig)}`
  }

  const json = (res: import("node:http").ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  }

  const server = createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    async (req, res) => {
      const url = new URL(req.url ?? "/", issuer)

      if (url.pathname === "/.well-known/openid-configuration") {
        return json(res, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          scopes_supported: ["openid", "email", "profile"],
          claims_supported: ["sub", "email", "email_verified", "name"],
        })
      }

      if (url.pathname === "/jwks") return json(res, { keys: [jwk] })

      if (url.pathname === "/authorize") {
        const redirect = url.searchParams.get("redirect_uri")
        if (!redirect) return json(res, { error: "invalid_request" }, 400)
        const code = randomBytes(12).toString("hex")
        codes.set(code, {
          nonce: url.searchParams.get("nonce") ?? undefined,
          clientId: url.searchParams.get("client_id") ?? "",
        })
        const back = new URL(redirect)
        back.searchParams.set("code", code)
        const state = url.searchParams.get("state")
        if (state) back.searchParams.set("state", state)
        res.writeHead(302, { location: back.toString() })
        return res.end()
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const form = new URLSearchParams(Buffer.concat(chunks).toString())
        let clientId = form.get("client_id") ?? ""
        let clientSecret = form.get("client_secret") ?? ""
        const basic = req.headers.authorization?.match(/^Basic (.+)$/)
        if (basic?.[1]) {
          const [id, ...rest] = Buffer.from(basic[1], "base64").toString().split(":")
          clientId = decodeURIComponent(id ?? "")
          clientSecret = decodeURIComponent(rest.join(":"))
        }
        const code = form.get("code") ?? ""
        const grant = codes.get(code)
        if (!grant) return json(res, { error: "invalid_grant" }, 400)
        codes.delete(code)
        tokenRequests.push({ clientId, clientSecret, code })

        const now = Math.floor(Date.now() / 1000)
        return json(res, {
          access_token: `at-${randomBytes(8).toString("hex")}`,
          token_type: "Bearer",
          expires_in: 3600,
          id_token: sign({
            iss: issuer,
            aud: clientId,
            sub: identity.sub,
            iat: now,
            exp: now + 3600,
            email: identity.email,
            email_verified: true,
            name: identity.name,
            ...(grant.nonce ? { nonce: grant.nonce } : {}),
          }),
        })
      }

      if (url.pathname === "/userinfo") {
        return json(res, {
          sub: identity.sub,
          email: identity.email,
          email_verified: true,
          name: identity.name,
        })
      }

      return json(res, { error: "not_found" }, 404)
    },
  )

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })

  return {
    issuer,
    certPath,
    tokenRequests,
    setIdentity: (next) => {
      identity = { name: "Fake User", ...next }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

// Standalone: print what the server under test needs, then serve until killed.
if (import.meta.main) {
  const port = Number(process.env.IDP_PORT ?? DEFAULT_IDP_PORT)
  const idp = await startFakeIdp(port)
  console.log(`fake IdP at ${idp.issuer}`)
  console.log(`server env: NODE_EXTRA_CA_CERTS=${idp.certPath} TRUSTED_ORIGINS=${idp.issuer}`)
}
