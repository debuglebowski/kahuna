import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { api, type DashboardWidget } from "@/lib/api"
import { sinceDays, timeBucket } from "@/lib/widgetAggregations"

type Trend = Extract<DashboardWidget, { type: "trend" }>

/** Time-series of events bucketed per day/week (from the event log via
 *  `listEvents`). Lazy-loaded by the canvas so chart-less boards skip recharts. */
export function TrendWidget({ widget }: { widget: Trend }) {
  const days = sinceDays(widget.since)
  // Captured once per render cycle so the bucket range is stable.
  const { from, to } = useMemo(() => {
    const now = Date.now()
    return { from: now - days * 86_400_000, to: now }
  }, [days])

  const q = useQuery({
    queryKey: ["events", widget.conceptId ?? null, "trend", widget.since],
    queryFn: () =>
      api.listEvents({ conceptId: widget.conceptId ?? undefined, since: from, limit: 2000 }),
  })

  const data = useMemo(() => {
    const events = q.data ?? []
    const types = widget.eventTypes
    const filtered =
      types && types.length > 0 ? events.filter((e) => types.includes(e.eventType)) : events
    return timeBucket(filtered, widget.bucket, from, to)
  }, [q.data, widget.eventTypes, widget.bucket, from, to])

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>
  const total = data.reduce((s, p) => s + p.count, 0)
  if (total === 0) return <p className="text-sm text-muted-foreground">No activity.</p>

  return (
    <div className="h-full w-full text-xs">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
          <XAxis dataKey="bucket" tick={{ fontSize: 10 }} minTickGap={24} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
          <Tooltip />
          <Line type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
