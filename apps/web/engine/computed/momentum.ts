export type MomentumLabel = "heating" | "steady" | "cooling"

export interface MomentumResult {
  readonly recent: number
  readonly prior: number
  readonly label: MomentumLabel
}

export interface MomentumParams {
  readonly windowDays?: number
  readonly forRelation?: string
  readonly onRelation?: string
  readonly dateField?: string
}

const DAY_MS = 86_400_000
export const DEFAULT_WINDOW_DAYS = 14

/**
 * Pure momentum: compare interaction count in the last `windowDays` vs the
 * previous `windowDays`. More -> heating, fewer -> cooling, equal -> steady.
 */
export const momentum = (
  interactionDates: ReadonlyArray<Date>,
  now: Date,
  params: MomentumParams = {},
): MomentumResult => {
  const window = (params.windowDays ?? DEFAULT_WINDOW_DAYS) * DAY_MS
  const t = now.getTime()
  let recent = 0
  let prior = 0
  for (const d of interactionDates) {
    const age = t - d.getTime()
    if (age >= 0 && age < window) recent += 1
    else if (age >= window && age < 2 * window) prior += 1
  }
  const label: MomentumLabel = recent > prior ? "heating" : recent < prior ? "cooling" : "steady"
  return { recent, prior, label }
}
