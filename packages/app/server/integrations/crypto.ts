import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto"

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
 * The key is REQUIRED in every environment — there is no fallback. An earlier
 * version derived one from `BETTER_AUTH_SECRET` outside production; that coupled
 * session-secret rotation to every stored credential, so it was removed. The two
 * older names (`INTEGRATION_TOKEN_ENCRYPTION_KEY`, `GOOGLE_TOKEN_ENCRYPTION_KEY`)
 * are not read either: rename the variable rather than expect it to be picked up.
 */
const encryptionKey = (): Buffer => {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY must be set: 32 bytes as base64 or 64-char hex " +
        "(e.g. `openssl rand -base64 32`)",
    )
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex")
  const decoded = Buffer.from(raw, "base64")
  if (decoded.length === 32) return decoded
  throw new Error(
    "INTEGRATION_ENCRYPTION_KEY is malformed — need 32 bytes as base64 or 64-char hex",
  )
}

/** Fail the boot, not the first encrypt, when the key is missing or malformed. */
export const assertEncryptionKey = (): void => {
  encryptionKey()
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
