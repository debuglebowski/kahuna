import { useLiveQuery } from "@tanstack/react-db"
import { ArrowRight, ChevronRight } from "lucide-react"
import { useState } from "react"
import {
  type ActivityResolvers,
  eventDetails,
  eventLabel,
  eventSnippet,
  relativeTime,
} from "../../lib/activity"
import type { Field } from "../../lib/api"
import {
  activityBySubject,
  KEY,
  taskStatusesCollection,
  useRegisterCollection,
} from "../../lib/collections"
import { FieldValueCell } from "../../lib/fieldDisplay"
import { cn } from "../../lib/utils"
import { useFullOrg } from "../../pages/settings/SettingsLayout"
import { Spinner } from "../ui"
import { MemberAvatar, memberLabel, type OrgMember } from "./AssigneePicker"

/**
 * Per-item activity feed — the union (server-side) of the lineage's own events
 * and its annotations' events, rendered newest-first. `subjectId` is the item
 * lineage id. Each row carries an inline snippet derived from the event
 * payload (changed field names, note preview, status transition, …) and
 * expands on click into the full metadata. `fields` (the concept's field defs)
 * resolves patch keys to names; actor user ids resolve to org members.
 */
export function ActivityFeed({
  subjectId,
  fields = [],
}: {
  subjectId: string
  fields?: ReadonlyArray<Field>
}) {
  const collection = activityBySubject(subjectId)
  useRegisterCollection(KEY.activity(subjectId), collection)
  const q = useLiveQuery((qb) => qb.from({ a: collection }), [subjectId, collection])
  // Status names for task-transition snippets. Read-only: no SSE registration
  // (TaskList owns that key while mounted; double-registration would drop it).
  const statusesQ = useLiveQuery((qb) => qb.from({ s: taskStatusesCollection }))
  const org = useFullOrg()
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())

  if (q.isLoading) return <Spinner />
  const items = [...(q.data ?? [])].sort((a, b) => b.id - a.id)
  if (items.length === 0)
    return <div className="p-6 text-sm text-muted-foreground">No activity yet.</div>

  const byUser = new Map<string, OrgMember>(
    (org.data?.members ?? []).map((m) => [m.userId, m as OrgMember]),
  )
  const byField = new Map(fields.map((f) => [f.id, f]))
  const byStatus = new Map((statusesQ.data ?? []).map((s) => [s.id, s.name]))
  const resolvers: ActivityResolvers = {
    fieldName: (id) => byField.get(id)?.name,
    statusName: (id) => byStatus.get(id),
    userName: (id) => {
      const m = byUser.get(id)
      return m ? memberLabel(m) : undefined
    },
  }

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="divide-y divide-border">
      {items.map((ev) => {
        const member = ev.actor ? byUser.get(ev.actor) : undefined
        const snippet = eventSnippet(ev.eventType, ev.payload, resolvers)
        const details = open.has(ev.id)
          ? eventDetails(ev.eventType, ev.payload, resolvers, ev.previous)
          : null
        return (
          <div key={ev.id}>
            <button
              type="button"
              onClick={() => toggle(ev.id)}
              aria-expanded={details !== null}
              className="flex w-full items-center gap-2.5 px-6 py-2.5 text-left text-sm hover:bg-accent/40"
            >
              {ev.actor ? (
                <MemberAvatar member={member} size={22} />
              ) : (
                <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-muted text-[0.6rem] text-muted-foreground">
                  sys
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-foreground">
                  {ev.actor ? memberLabel(member) : "System"}
                </span>{" "}
                <span className="text-muted-foreground">{eventLabel(ev.eventType)}</span>
                {snippet && <span className="text-muted-foreground/70"> — {snippet}</span>}
              </span>
              <span
                className="shrink-0 text-xs text-muted-foreground"
                title={new Date(ev.occurredAt).toLocaleString()}
              >
                {relativeTime(new Date(ev.occurredAt))}
              </span>
              <ChevronRight
                size={14}
                className={cn(
                  "shrink-0 text-muted-foreground/50 transition-transform",
                  details !== null && "rotate-90",
                )}
              />
            </button>
            {details !== null && (
              <div className="space-y-1.5 px-6 pt-0.5 pb-3 pl-14 text-sm">
                {details.map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: derived rows, order-stable
                  <div key={i} className="flex gap-3">
                    <span className="w-28 shrink-0 truncate text-xs leading-5 text-muted-foreground">
                      {row.label}
                    </span>
                    <span className="min-w-0 whitespace-pre-wrap break-words">
                      {row.fieldId ? (
                        row.hasPrev ? (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            <span className="opacity-60">
                              {/* A bare dash for "was empty" — FieldValueCell would flag a
                                  required field's null as a "missing" badge, wrong in a diff. */}
                              {row.prev === null ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                <FieldValueCell field={byField.get(row.fieldId)} value={row.prev} />
                              )}
                            </span>
                            <ArrowRight size={12} className="shrink-0 text-muted-foreground" />
                            <FieldValueCell field={byField.get(row.fieldId)} value={row.value} />
                          </span>
                        ) : (
                          <FieldValueCell field={byField.get(row.fieldId)} value={row.value} />
                        )
                      ) : (
                        row.text
                      )}
                    </span>
                  </div>
                ))}
                <div className="text-xs text-muted-foreground/70">
                  {new Date(ev.occurredAt).toLocaleString()}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
