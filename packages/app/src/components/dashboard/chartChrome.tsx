import type { ReactElement, ReactNode } from "react"
import { CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts"
import { cn } from "@/lib/utils"

/**
 * Chrome shared by the time-series widgets (Trend and Analytics): the
 * period-over-period delta header, and the recharts grid/axis/margin config.
 *
 * The delta header was byte-identical 22 lines in both files, and the axis config
 * appeared three times (twice in Trend, once in Analytics — which had already
 * hoisted it to `margin`/`grid`/`axes` consts; this follows that pattern).
 *
 * Only the delta field name differed: Trend's projection calls it `prev`,
 * Analytics' calls it `prior`. Callers pass the two numbers, so neither has to
 * rename its API shape.
 */

/** Shared recharts layout: identical in every chart both widgets render. */
export const CHART_MARGIN = { top: 8, right: 8, bottom: 0, left: -16 } as const

export const ChartGrid = () => (
  <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
)

export const ChartAxes = () => (
  <>
    <XAxis dataKey="bucket" tick={{ fontSize: 10 }} minTickGap={24} />
    <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
  </>
)

/**
 * Percentage change, or null when there is no prior baseline to compare against
 * (a zero prior would divide by zero, and "∞%" is not a useful reading — the
 * header renders "new" instead).
 */
export const pctChangeOf = (cur: number, prior: number): number | null =>
  prior > 0 ? Math.round(((cur - prior) / prior) * 100) : null

/** The period-over-period delta line above a time-series chart. */
export function DeltaHeader({ cur, prior, since }: { cur: number; prior: number; since: string }) {
  const pctChange = pctChangeOf(cur, prior)
  return (
    <div className="flex shrink-0 items-baseline gap-2 pb-1">
      <span
        className={cn(
          "text-sm font-semibold tabular-nums",
          pctChange == null
            ? "text-muted-foreground"
            : pctChange >= 0
              ? "text-success"
              : "text-destructive",
        )}
      >
        {pctChange == null ? (cur > 0 ? "new" : "—") : `${pctChange >= 0 ? "+" : ""}${pctChange}%`}
      </span>
      <span className="text-muted-foreground">vs prior {since}</span>
    </div>
  )
}

/**
 * The outer frame both widgets wrap their chart in: an optional delta header
 * above a chart that fills the remaining height.
 */
export function ChartFrame({ header, children }: { header?: ReactNode; children: ReactElement }) {
  return (
    <div className="flex h-full w-full flex-col text-xs">
      {header}
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  )
}
