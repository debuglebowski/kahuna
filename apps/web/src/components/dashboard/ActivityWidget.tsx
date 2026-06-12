import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { api, type DashboardWidget, type FeedItem } from "@/lib/api"

type Activity = Extract<DashboardWidget, { type: "activity" }>

/** "InstanceCreated" → "Instance created". */
const humanize = (t: string): string => {
  const spaced = t.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/** Compact "5m / 3h / 2d / date" relative time. */
const relTime = (d: Date | string): string => {
  const ms = Date.now() - new Date(d).getTime()
  const m = Math.floor(ms / 60_000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d`
  return new Date(d).toLocaleDateString()
}

/** The shared event-list rendering (humanized type + relative time, instance
 *  events click through) — used by the Activity widget and the member profile. */
export function EventRows({ events }: { events: readonly FeedItem[] }) {
  const navigate = useNavigate()
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No activity.</p>
  return (
    <ul className="divide-y divide-border">
      {events.map((e) => {
        const toInstance = e.subjectKind === "instance"
        return (
          <li key={e.id} className="flex items-center justify-between gap-2 py-1 text-sm">
            <button
              type="button"
              disabled={!toInstance}
              onClick={() => toInstance && navigate(`/instances/${e.subjectId}`)}
              className="truncate text-left text-foreground enabled:hover:underline disabled:cursor-default"
            >
              {humanize(e.eventType)}
            </button>
            <span className="shrink-0 text-xs text-muted-foreground">{relTime(e.occurredAt)}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** Recent events as a list (whole-org, or one concept's instance events). */
export function ActivityWidget({ widget }: { widget: Activity }) {
  const limit = widget.limit ?? 20
  const q = useQuery({
    queryKey: ["events", widget.conceptId ?? null, "activity", limit],
    queryFn: () => api.listEvents({ conceptId: widget.conceptId ?? undefined, limit }),
  })
  const events = (q.data ?? []).slice(0, limit)

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>

  return (
    <div className="h-full overflow-auto">
      <EventRows events={events} />
    </div>
  )
}
