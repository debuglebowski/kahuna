import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { useFields } from "@/components/ConditionList"
import { MemberAvatar, memberLabel, type OrgMember } from "@/components/item/AssigneePicker"
import { type ActivityResolvers, eventLabel, eventSnippet, relativeTime } from "@/lib/activity"
import { api, type DashboardWidget, type FeedItem } from "@/lib/api"
import { taskStatusesCollection } from "@/lib/collections"
import { recordHref } from "@/lib/recordHref"
import { useFullOrg } from "@/pages/settings/SettingsLayout"

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
 *  events click through) — used by the member profile page. */
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
              onClick={() => toInstance && navigate(recordHref(e.subjectId))}
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

/** Recent events as a feed (whole-org, or one concept's instance events).
 *  Variants: an avatar timeline rail (default) or a dense log. Inline diff
 *  snippets reuse the activity-feed derivations. */
export function ActivityWidget({ widget }: { widget: Activity }) {
  const navigate = useNavigate()
  const limit = widget.limit ?? 20
  const types = widget.eventTypes
  const q = useQuery({
    queryKey: ["events", widget.conceptId ?? null, "activity", limit, [...(types ?? [])].join()],
    queryFn: () => api.listEvents({ conceptId: widget.conceptId ?? undefined, limit }),
  })

  const org = useFullOrg()
  // Field names resolve diff snippets only when the feed is concept-scoped.
  const fieldsQ = useFields(widget.conceptId ?? "")
  // Read-only: no SSE registration (TaskList owns that key while mounted;
  // double-registration would drop it) — same caveat as the item ActivityFeed.
  const statusesQ = useLiveQuery((qb) => qb.from({ s: taskStatusesCollection }))

  const byUser = new Map<string, OrgMember>(
    (org.data?.members ?? []).map((m) => [m.userId, m as OrgMember]),
  )
  const byField = new Map((fieldsQ.data ?? []).map((f) => [f.id, f.name]))
  const byStatus = new Map((statusesQ.data ?? []).map((s) => [s.id, s.name]))
  const resolvers: ActivityResolvers = {
    fieldName: (id) => byField.get(id),
    statusName: (id) => byStatus.get(id),
    userName: (id) => {
      const m = byUser.get(id)
      return m ? memberLabel(m) : undefined
    },
  }

  const events = (q.data ?? [])
    .filter((e) => !types || types.length === 0 || types.includes(e.eventType))
    .slice(0, limit)

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No activity.</p>

  const log = (widget.variant ?? "timeline") === "log"
  const showDiffs = widget.showDiffs ?? true
  const open = (e: FeedItem) => e.subjectKind === "instance" && navigate(recordHref(e.subjectId))

  if (log) {
    return (
      <div className="h-full overflow-auto">
        <ul className="divide-y divide-border">
          {events.map((e) => {
            const snippet = showDiffs ? eventSnippet(e.eventType, e.payload, resolvers) : null
            const toInstance = e.subjectKind === "instance"
            return (
              <li key={e.id} className="flex items-center gap-2 py-1 text-sm">
                <span className="w-10 shrink-0 text-xs tabular-nums text-muted-foreground">
                  {relTime(e.occurredAt)}
                </span>
                <button
                  type="button"
                  disabled={!toInstance}
                  onClick={() => open(e)}
                  className="min-w-0 flex-1 truncate text-left enabled:hover:underline disabled:cursor-default"
                >
                  <span className="font-medium text-foreground">
                    {e.actor ? memberLabel(byUser.get(e.actor)) : "System"}
                  </span>{" "}
                  <span className="text-muted-foreground">{eventLabel(e.eventType)}</span>
                  {snippet && <span className="text-muted-foreground/70"> — {snippet}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <ul>
        {events.map((e, idx) => {
          const member = e.actor ? byUser.get(e.actor) : undefined
          const snippet = showDiffs ? eventSnippet(e.eventType, e.payload, resolvers) : null
          const toInstance = e.subjectKind === "instance"
          return (
            <li key={e.id} className="relative flex gap-2.5 pb-2.5">
              {/* the rail: a connector line under every avatar but the last */}
              {idx < events.length - 1 && (
                <span className="absolute top-6 left-[11px] h-full w-px bg-border" aria-hidden />
              )}
              {e.actor ? (
                <MemberAvatar member={member} size={22} />
              ) : (
                <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-muted text-[0.6rem] text-muted-foreground">
                  sys
                </span>
              )}
              <button
                type="button"
                disabled={!toInstance}
                onClick={() => open(e)}
                className="min-w-0 flex-1 text-left text-sm enabled:hover:underline disabled:cursor-default"
              >
                <span className="font-medium text-foreground">
                  {e.actor ? memberLabel(member) : "System"}
                </span>{" "}
                <span className="text-muted-foreground">{eventLabel(e.eventType)}</span>
                {snippet && (
                  <span className="block truncate text-xs text-muted-foreground/80">{snippet}</span>
                )}
              </button>
              <span
                className="shrink-0 text-xs text-muted-foreground"
                title={new Date(e.occurredAt).toLocaleString()}
              >
                {relativeTime(new Date(e.occurredAt))}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
