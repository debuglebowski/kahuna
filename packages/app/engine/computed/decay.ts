export type DecayBand = "fresh" | "warm" | "cooling" | "cold"

export interface DecayResult {
  readonly days: number | null
  readonly band: DecayBand
}

export interface DecayBands {
  readonly fresh: number
  readonly warm: number
  readonly cooling: number
}

export interface DecayParams {
  readonly bands?: DecayBands
  /** relation Deal -> Account (default "for") */
  readonly forRelation?: string
  /** relation Interaction -> Account (default "on") */
  readonly onRelation?: string
  /** date field on Interaction (default "occurred_on") */
  readonly dateField?: string
}

const DAY_MS = 86_400_000
export const DEFAULT_DECAY_BANDS: DecayBands = { fresh: 7, warm: 14, cooling: 30 }

/**
 * Pure decay: days since the most recent interaction, plus a band.
 * Spec bands: fresh <7, warm 7–14, cooling 14–30, cold >30.
 * With no interactions, falls back to the deal's age (`fallbackDate`).
 */
export const decay = (
  interactionDates: ReadonlyArray<Date>,
  now: Date,
  params: DecayParams = {},
  fallbackDate?: Date,
): DecayResult => {
  const bands = params.bands ?? DEFAULT_DECAY_BANDS
  const dates = interactionDates.length > 0 ? interactionDates : fallbackDate ? [fallbackDate] : []
  if (dates.length === 0) return { days: null, band: "cold" }

  const last = Math.max(...dates.map((d) => d.getTime()))
  const days = Math.floor((now.getTime() - last) / DAY_MS)
  const band: DecayBand =
    days < bands.fresh
      ? "fresh"
      : days < bands.warm
        ? "warm"
        : days < bands.cooling
          ? "cooling"
          : "cold"
  return { days, band }
}
