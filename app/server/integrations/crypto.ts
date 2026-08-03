import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

/**
 * AES-256-GCM token crypto shared by every integration connector (Google,
 * PostHog, …). Lifted verbatim from the original Google implementation so the
 * ciphertext format (`v1.<iv>.<tag>.<body>`, all base64url) is unchanged and
 * existing rows keep decrypting.
 *
 * The 32-byte key comes from `INTEGRATION_ENCRYPTION_KEY` as base64 or 64-char
 * hex. It protects API keys and webhook secrets as well as OAuth tokens, which
 * is why the name no longer says "TOKEN".
 *
 * The two earlier names — `INTEGRATION_TOKEN_ENCRYPTION_KEY` and
 * `GOOGLE_TOKEN_ENCRYPTION_KEY` — are NOT read anymore. A deployment still on
 * one of them fails closed in production (the throw below) rather than falling
 * back to a key the operator did not choose. Outside production it would
 * silently derive a different key and stop decrypting existing rows, so rename
 * the variable before starting a dev server that holds real tokens.
 *
 * FALLBACK, non-production only: a key derived from `BETTER_AUTH_SECRET`, so a
 * local checkout needs no extra config. Two guard rails on it, because this used
 * to be looser than it looked:
 *
 *  - `BETTER_AUTH_SECRET` must actually be set, and must not be the published dev
 *    placeholder. It previously defaulted to `"dev-secret-change-me"`, so with
 *    neither variable configured every stored token was encrypted under a
 *    constant that is in this repo — i.e. readable by anyone with the ciphertext.
 *  - Deriving from the session secret COUPLES the two: rotating
 *    `BETTER_AUTH_SECRET` (documented as merely invalidating sessions) silently
 *    makes every stored integration token undecryptable. The warning below is the
 *    only place that says so out loud, so any deployment holding real tokens gets
 *    told to set a dedicated key.
 */
const DEV_PLACEHOLDER_SECRET = "dev-secret-change-me"
let warnedAboutDerivedKey = false

const encryptionKey = (): Buffer => {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY
  if (raw) {
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex")
    const decoded = Buffer.from(raw, "base64")
    if (decoded.length === 32) return decoded
    // A set-but-malformed key is a configuration mistake in every environment.
    // Falling through to the derived key would encrypt real tokens under
    // something the operator did not choose and cannot reproduce.
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY is set but malformed — need 32 bytes as base64 or 64-char hex",
    )
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must be 32 bytes as base64 or 64-char hex")
  }
  const authSecret = process.env.BETTER_AUTH_SECRET
  if (!authSecret || authSecret === DEV_PLACEHOLDER_SECRET) {
    throw new Error(
      "Set INTEGRATION_ENCRYPTION_KEY (32 bytes base64/hex), or a real BETTER_AUTH_SECRET to derive it from. " +
        `Refusing to encrypt tokens under the published placeholder "${DEV_PLACEHOLDER_SECRET}".`,
    )
  }
  if (!warnedAboutDerivedKey) {
    warnedAboutDerivedKey = true
    console.warn(
      "[integrations/crypto] No INTEGRATION_ENCRYPTION_KEY; deriving the token key from " +
        "BETTER_AUTH_SECRET. Rotating that secret will make every stored integration token " +
        "undecryptable. Set a dedicated key before storing tokens you care about.",
    )
  }
  return createHash("sha256").update(authSecret).digest()
}

export const encryptToken = (token: string | null | undefined): string | null => {
  if (!token) return null
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`
}

/**
 * Constant-time secret comparison for the inbound webhook/callback endpoints
 * (Clay callback, Gmail Pub/Sub push). Shared so each connector doesn't
 * re-derive it — and so nobody reaches for `===`, which leaks the secret one
 * character at a time.
 *
 * The BYTE-length guard is required, not just an optimisation: `timingSafeEqual`
 * throws on a length mismatch, and comparing `.length` (UTF-16 code units) is not
 * the same test — a multibyte string can match on characters while differing in
 * bytes. Length is not itself secret here.
 */
export const secretMatches = (
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean => {
  if (!provided || !expected) return false
  const a = Buffer.from(provided, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * The per-connection webhook token, from either the header (preferred — keeps it
 * out of access logs) or the legacy `?token=` query param.
 *
 * Both are accepted deliberately: the query form is what older deployments have
 * already pasted into the provider's config, and silently breaking their delivery
 * to tidy this up would be worse than the logging exposure. New URLs handed out by
 * the status endpoints carry no token.
 */
export const webhookTokenFrom = (req: Request, url: URL): string | null =>
  req.headers.get("x-km-webhook-token") ?? url.searchParams.get("token")

export const decryptToken = (value: string | null | undefined): string | null => {
  if (!value) return null
  const [version, ivRaw, tagRaw, bodyRaw] = value.split(".")
  if (version !== "v1" || !ivRaw || !tagRaw || !bodyRaw) return value
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"))
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(bodyRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}
