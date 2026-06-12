import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { api, type DashboardWidget } from "@/lib/api"
import { cn } from "@/lib/utils"
import { sinceDays, timeBucket } from "@/lib/widgetAggregations"

type Trend = Extract<DashboardWidget, { type: "trend" }>

const DAY_MS = 86_400_000

/** Time-series of events bucketed per day/week (from the event log via
 *  `listEvents`). Lazy-loaded by the canvas so chart-less boards skip recharts.
 *  Optional header verdict: % change vs the prior period of the same length. */
export function TrendWidget({ widget }: { widget: Trend }) {
  const days = sinceDays(widget.since)
  const showDelta = widget.showDelta ?? false
  // Captured once per render cycle so the bucket range is stable. The delta
  // needs the prior period too, so the fetch window doubles when it's on.
  const { from, to, fetchFrom } = useMemo(() => {
    const now = Date.now()
    const f = now - days * DAY_MS
    return { from: f, to: now, fetchFrom: showDelta ? f - days * DAY_MS : f }
  }, [days, showDelta])

  const q = useQuery({
    queryKey: ["events", widget.conceptId ?? null, "trend", widget.since, showDelta],
    queryFn: () =>
      api.listEvents({ conceptId: widget.conceptId ?? undefined, since: fetchFrom, limit: 2000 }),
  })

  const { data, delta } = useMemo(() => {
    const events = q.data ?? []
    const types = widget.eventTypes
    const filtered =
      types && types.length > 0 ? events.filter((e) => types.includes(e.eventType)) : events
    const ms = (e: { occurredAt: Date | string }) => new Date(e.occurredAt).getTime()
    const cur = filtered.filter((e) => ms(e) >= from).length
    const prev = filtered.filter((e) => ms(e) < from).length
    return {
      data: timeBucket(
        filtered.filter((e) => ms(e) >= from),
        widget.bucket,
        from,
        to,
      ),
      delta: showDelta ? { cur, prev } : null,
    }
  }, [q.data, widget.eventTypes, widget.bucket, from, to, showDelta])

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>
  const total = data.reduce((s, p) => s + p.count, 0)
  if (total === 0 && !delta) return <p className="text-sm text-muted-foreground">No activity.</p>

  const pctChange =
    delta && delta.prev > 0 ? Math.round(((delta.cur - delta.prev) / delta.prev) * 100) : null

  const chart =
    widget.chart === "bars" ? (
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
        <XAxis dataKey="bucket" tick={{ fontSize: 10 }} minTickGap={24} />
        <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
        <Tooltip />
        <Bar dataKey="count" fill="#6366f1" radius={[2, 2, 0, 0]} />
      </BarChart>
    ) : (
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
        <XAxis dataKey="bucket" tick={{ fontSize: 10 }} minTickGap={24} />
        <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
        <Tooltip />
        <Area
          type="monotone"
          dataKey="count"
          stroke="#6366f1"
          strokeWidth={2}
          fill="#6366f1"
          fillOpacity={0.15}
          dot={false}
        />
      </AreaChart>
    )

  return (
    <div className="flex h-full w-full flex-col text-xs">
      {delta && (
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
            {pctChange == null
              ? delta.cur > 0
                ? "new"
                : "—"
              : `${pctChange >= 0 ? "+" : ""}${pctChange}%`}
          </span>
          <span className="text-muted-foreground">vs prior {widget.since}</span>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          {chart}
        </ResponsiveContainer>
      </div>
    </div>
  )
}
