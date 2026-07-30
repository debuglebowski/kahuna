import { ConceptService } from "#engine"
import { Effect } from "effect"
import { runEngineOrThrow } from "../runtime"

/**
 * CLI: `bun server/seed/backfill-concept-colors.ts <orgId>` — give every live,
 * colorless concept a default color, unique within the org. Idempotent: colored
 * concepts are untouched; re-running is a no-op once all have colors. Goes
 * through ConceptService.update, so each assignment is event-sourced.
 *
 * The 20 regular pill hexes (spectral order) from the web palette
 * (`PILL_COLORS` in app/src/components/ui.tsx) — regulars only, so
 * backfilled sets read as one rainbow run; deep variants stay hand-pickable.
 */
const PALETTE = [
  "#ef4444", // Red
  "#f97316", // Orange
  "#f59e0b", // Amber
  "#eab308", // Yellow
  "#84cc16", // Lime
  "#22c55e", // Green
  "#10b981", // Emerald
  "#14b8a6", // Teal
  "#06b6d4", // Cyan
  "#0ea5e9", // Sky
  "#3b82f6", // Blue
  "#6366f1", // Indigo
  "#8b5cf6", // Violet
  "#a855f7", // Purple
  "#d946ef", // Fuchsia
  "#ec4899", // Pink
  "#f43f5e", // Rose
  "#64748b", // Slate
  "#6b7280", // Gray
  "#78716c", // Stone
]

const orgId = process.argv[2]
if (!orgId) {
  console.error("usage: bun server/seed/backfill-concept-colors.ts <orgId>")
  process.exit(1)
}

const result = await runEngineOrThrow(
  { orgId, actor: "system" },
  Effect.gen(function* () {
    const concepts = yield* ConceptService
    const all = yield* concepts.list()
    const taken = new Set(all.flatMap((c) => (c.color ? [c.color.toLowerCase()] : [])))
    const assigned: string[] = []
    for (const c of all) {
      if (c.color) continue
      const hex = PALETTE.find((h) => !taken.has(h)) ?? PALETTE[assigned.length % PALETTE.length]!
      taken.add(hex)
      yield* concepts.update({ id: c.id, description: c.description, color: hex })
      assigned.push(`${c.name} → ${hex}`)
    }
    return assigned
  }),
)
console.log(result.length ? result.join("\n") : "all concepts already colored")
process.exit(0)
