import "../env" // Load repo-root .env before the engine reads DATABASE_URL.
import { runEngineOrThrow, systemScope } from "../runtime"
import { seedKingsmaker } from "./seed"

/**
 * CLI: `bun server/seed/run.ts <orgId>` — seed the Kingsmaker schema into an org.
 * The org id is a BetterAuth organization.id (Tier-0). Safe to re-run.
 */
const orgId = process.argv[2] ?? process.env.SEED_ORG_ID
if (!orgId) {
  console.error("usage: bun server/seed/run.ts <orgId>")
  process.exit(1)
}

const result = await runEngineOrThrow(systemScope(orgId, "system"), seedKingsmaker)
console.log(`Seeded ${result.concepts} concepts into org ${orgId}`)
process.exit(0)
