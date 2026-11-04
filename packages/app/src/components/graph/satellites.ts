import type { Box } from "../../lib/graphRouting"

/**
 * "Satellite" cards: small per-concept copies of a built-in node (e.g. one
 * Member card next to each concept with member fields, instead of one shared
 * Member card everything points at). They're derived, never saved: their
 * position is recomputed from the parent's box on every render, so they follow
 * the parent when it's dragged.
 */

/** Gap between a parent card and its satellite. */
export const SATELLITE_GAP = 24
/** Clearance kept from other cards when choosing a side. */
const CLEARANCE = 8

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w + CLEARANCE &&
  b.x < a.x + a.w + CLEARANCE &&
  a.y < b.y + b.h + CLEARANCE &&
  b.y < a.y + a.h + CLEARANCE

/**
 * Place each satellite on the first free side of its parent — right, below,
 * left, above (right first: Auto layout reserves that room) — avoiding every
 * obstacle and every satellite already placed. If no side is free it goes on
 * the right anyway; overlapping beats disappearing.
 *
 * Deterministic: parents are processed in the given order.
 */
export function placeSatellites(
  parents: ReadonlyArray<{ id: string; box: Box; size: { w: number; h: number } }>,
  obstacles: ReadonlyArray<Box>,
): Map<string, { x: number; y: number }> {
  const taken: Box[] = [...obstacles]
  const out = new Map<string, { x: number; y: number }>()
  for (const { id, box: p, size } of parents) {
    const { w, h } = size
    const cx = p.x + (p.w - w) / 2
    const cy = p.y + (p.h - h) / 2
    const sides = [
      { x: p.x + p.w + SATELLITE_GAP, y: cy },
      { x: cx, y: p.y + p.h + SATELLITE_GAP },
      { x: p.x - SATELLITE_GAP - w, y: cy },
      { x: cx, y: p.y - SATELLITE_GAP - h },
    ]
    // The parent may be among the obstacles; every side is SATELLITE_GAP clear
    // of it, which exceeds CLEARANCE, so it never blocks its own satellite.
    const pick =
      sides.find((s) => !taken.some((o) => overlaps({ ...s, w, h }, o))) ??
      (sides[0] as { x: number; y: number })
    out.set(id, pick)
    taken.push({ ...pick, w, h })
  }
  return out
}
