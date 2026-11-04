import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer } from "effect"
import { OrgContext } from "./OrgContext"

/** Org-wide data defaults (`org_settings`). NULL = not set. */
export interface OrgSettings {
  readonly defaultCurrency: string | null
}

interface OrgSettingsRow {
  readonly default_currency: string | null
}

const EMPTY: OrgSettings = { defaultCurrency: null }

/**
 * The org's data defaults. Member-READABLE (anyone writing a money value needs
 * the default currency); the write is gated `configure` on the org at the RPC
 * boundary. The engine only owns the row — shape validation is the contract's.
 */
export class OrgSettingsService extends Context.Service<OrgSettingsService>()(
  "engine/OrgSettingsService",
  {
    make: Effect.gen(function* () {
      const sql = yield* PgClient.PgClient

      /** The org's settings; all-null when never saved. */
      const get = () =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          const rows = yield* sql<OrgSettingsRow>`
            SELECT default_currency FROM org_settings WHERE org_id = ${orgId} LIMIT 1`
          const r = rows[0]
          return r ? ({ defaultCurrency: r.default_currency } as OrgSettings) : EMPTY
        })

      /** Patch semantics: an omitted key is left alone, an explicit null clears. */
      const update = (patch: { readonly defaultCurrency?: string | null }) =>
        Effect.gen(function* () {
          const { orgId } = yield* OrgContext
          if (patch.defaultCurrency !== undefined) {
            yield* sql`
              INSERT INTO org_settings (org_id, default_currency, updated_at)
              VALUES (${orgId}, ${patch.defaultCurrency}, now())
              ON CONFLICT (org_id)
              DO UPDATE SET default_currency = EXCLUDED.default_currency, updated_at = now()`
          }
          return yield* get()
        })

      return { get, update } as const
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)
}
