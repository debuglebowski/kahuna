import type { BetterAuthOptions } from "better-auth"
import type { DBAdapter, DBTransactionAdapter } from "better-auth/types"
import { decryptToken, encryptToken } from "./integrations/crypto"

/**
 * Encrypts the OIDC `clientSecret` inside `bauth_sso_provider.oidc_config` at
 * rest, without owning or forking the SSO plugin.
 *
 * The plugin reads and writes that column only through `ctx.context.adapter`
 * (`create`/`update`/`findOne`/`findMany`), so wrapping the adapter is a single
 * seam: values are encrypted on the way down and decrypted on the way up, and the
 * plugin never sees ciphertext. Only the `clientSecret` field is encrypted — the
 * column stays valid JSON, so raw reads (`sso.ts` `providerPayload`) still parse.
 *
 * Legacy rows holding a plaintext secret keep working (`decryptToken` passes
 * non-`v1.` values through) and are re-encrypted the next time they are written.
 * No schema change.
 */

const MODEL = "ssoProvider"
const FIELD = "oidcConfig"

const mapConfig = (raw: unknown, fn: (secret: string) => string | null): unknown => {
  if (typeof raw !== "string") return raw
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!cfg || typeof cfg.clientSecret !== "string" || !cfg.clientSecret) return raw
  const next = fn(cfg.clientSecret)
  return next === null ? raw : JSON.stringify({ ...cfg, clientSecret: next })
}

// Never double-encrypt a value that is already ciphertext (e.g. an update that
// round-trips a row read without the wrapper).
const isCiphertext = (s: string) => /^v1\.[^.]+\.[^.]+\.[^.]+$/.test(s)
const seal = (raw: unknown) => mapConfig(raw, (s) => (isCiphertext(s) ? s : encryptToken(s)))
const open = (raw: unknown) => mapConfig(raw, (s) => decryptToken(s))

const mapRow = <T>(row: T, fn: (raw: unknown) => unknown): T => {
  if (!row || typeof row !== "object" || !(FIELD in row)) return row
  const r = row as Record<string, unknown>
  return { ...r, [FIELD]: fn(r[FIELD]) } as T
}

const mapData = (
  model: string,
  data: Record<string, any> | undefined,
): Record<string, any> | undefined =>
  model === MODEL && data && FIELD in data ? mapRow(data, seal) : data

type Adapter = DBAdapter<BetterAuthOptions> | DBTransactionAdapter<BetterAuthOptions>

const wrap = <A extends Adapter>(inner: A): A => {
  const out = (model: string, row: any) => (model === MODEL ? mapRow(row, open) : row)
  const wrapped = {
    ...inner,
    create: async (args: any) =>
      out(args.model, await inner.create({ ...args, data: mapData(args.model, args.data) })),
    update: async (args: any) =>
      out(args.model, await inner.update({ ...args, update: mapData(args.model, args.update) })),
    updateMany: (args: any) =>
      inner.updateMany({ ...args, update: mapData(args.model, args.update) }),
    findOne: async (args: any) => out(args.model, await inner.findOne(args)),
    findMany: async (args: any) => {
      const rows: any[] = await inner.findMany(args)
      return args.model === MODEL ? rows.map((r) => mapRow(r, open)) : rows
    },
  } as unknown as A
  if ("transaction" in inner && typeof inner.transaction === "function") {
    const tx = inner.transaction.bind(inner) as (cb: (t: any) => Promise<any>) => Promise<any>
    ;(wrapped as any).transaction = (cb: (t: any) => Promise<any>) => tx((t) => cb(wrap(t)))
  }
  return wrapped
}

/** Wrap a better-auth adapter factory so SSO client secrets are sealed at rest. */
export const withSsoSecretEncryption =
  (factory: (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions>) =>
  (options: BetterAuthOptions): DBAdapter<BetterAuthOptions> =>
    wrap(factory(options))
