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
 * The 32-byte key comes from `INTEGRATION_TOKEN_ENCRYPTION_KEY` (preferred) or
 * the legacy `GOOGLE_TOKEN_ENCRYPTION_KEY` (back-compat) as base64 or 64-char
 * hex. In non-production, with neither set, it derives a stable key from
 * `BETTER_AUTH_SECRET` so local/test runs don't need extra config.
 */
const encryptionKey = (): Buffer => {
  const raw =
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ?? process.env.GOOGLE_TOKEN_ENCRYPTION_KEY
  if (raw) {
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex")
    const decoded = Buffer.from(raw, "base64")
    if (decoded.length === 32) return decoded
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("INTEGRATION_TOKEN_ENCRYPTION_KEY must be 32 bytes as base64 or 64-char hex")
  }
  return createHash("sha256")
    .update(process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me")
    .digest()
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
