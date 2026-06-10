import { useLiveQuery } from "@tanstack/react-db"
import { eventLabel, relativeTime } from "../../lib/activity"
import { activityBySubject, KEY, useRegisterCollection } from "../../lib/collections"
import { useFullOrg } from "../../pages/settings/SettingsLayout"
import { Spinner } from "../ui"
import { MemberAvatar, memberLabel, type OrgMember } from "./AssigneePicker"

/**
 * Per-item activity feed — the union (server-side) of the lineage's own events
 * and its annotations' events, rendered newest-first. `subjectId` is the item
 * lineage id. Actor user ids resolve to org members for the avatar/name.
 */
export function ActivityFeed({ subjectId }: { subjectId: string }) {
  const collection = activityBySubject(subjectId)
  useRegisterCollection(KEY.activity(subjectId), collection)
  const q = useLiveQuery((qb) => qb.from({ a: collection }), [subjectId, collection])
  const org = useFullOrg()

  if (q.isLoading) return <Spinner />
  const items = [...(q.data ?? [])].sort((a, b) => b.id - a.id)
  if (items.length === 0)
    return <div className="p-6 text-sm text-muted-foreground">No activity yet.</div>

  const byUser = new Map<string, OrgMember>(
    (org.data?.members ?? []).map((m) => [m.userId, m as OrgMember]),
  )

  return (
    <div className="divide-y divide-border">
      {items.map((ev) => {
        const member = ev.actor ? byUser.get(ev.actor) : undefined
        return (
          <div key={ev.id} className="flex items-center gap-2.5 px-6 py-2.5 text-sm">
            {ev.actor ? (
              <MemberAvatar member={member} size={22} />
            ) : (
              <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-muted text-[0.6rem] text-muted-foreground">
                sys
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="font-medium text-foreground">
                {ev.actor ? memberLabel(member) : "System"}
              </span>{" "}
              <span className="text-muted-foreground">{eventLabel(ev.eventType)}</span>
            </span>
            <span
              className="shrink-0 text-xs text-muted-foreground"
              title={new Date(ev.occurredAt).toLocaleString()}
            >
              {relativeTime(new Date(ev.occurredAt))}
            </span>
          </div>
        )
      })}
    </div>
  )
}
