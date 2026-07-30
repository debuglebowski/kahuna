import { healthCheck, PgLive } from "#engine"
import { Effect } from "effect"

/**
 * Standalone DB health probe (Phase 0 acceptance check).
 * Run with `bun run health` from the repo root.
 */
const ok = await Effect.runPromise(healthCheck.pipe(Effect.provide(PgLive))).catch(
  (error: unknown) => {
    console.error("DB health: ERROR")
    console.error(error)
    return false
  },
)

console.log(ok ? "DB health: OK" : "DB health: FAIL")
process.exit(ok ? 0 : 1)
