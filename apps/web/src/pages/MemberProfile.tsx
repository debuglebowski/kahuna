import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Activity, ListTodo, Mail } from "lucide-react"
import { useMemo } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { EventRows } from "@/components/dashboard/ActivityWidget"
import { isOverdue } from "@/components/item/DueDateControl"
import { Dot } from "@/components/item/StatusSelect"
import { Badge, Card, Spinner } from "@/components/ui"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { api, type Task } from "@/lib/api"
import {
  KEY,
  taskStatusesCollection,
  tasksGlobalCollection,
  useRegisterCollection,
} from "@/lib/collections"
import { formatDateValue } from "@/lib/dates"
import { memberLabel, useMembers } from "@/lib/members"
import { isSnoozed } from "@/lib/taskGroups"
import { initialsOf } from "@/lib/utils"

const roleTone = (role: string) => (role === "owner" ? "blue" : role === "admin" ? "amber" : "gray")

/** How many of the member's open tasks / authored events the page shows. */
const TASK_LIMIT = 5
const EVENT_LIMIT = 10

/**
 * A member's profile page (`/members/:userId`): identity header plus two fixed
 * sections — the member's open tasks (top 5 from the global task layer) and
 * their recent activity (org events they authored). No per-member widget
 * canvas; the page reads the same live layers everything else does.
 */
export function MemberProfile() {
  const { userId = "" } = useParams()
  const navigate = useNavigate()
  const { members, deactivatedSet, isPending: membersPending } = useMembers()

  useRegisterCollection(KEY.tasksGlobal, tasksGlobalCollection)
  useRegisterCollection(KEY.taskStatuses, taskStatusesCollection)
  const tasksQ = useLiveQuery((q) => q.from({ t: tasksGlobalCollection }))
  const statusesQ = useLiveQuery((q) => q.from({ s: taskStatusesCollection }))

  const statusById = useMemo(
    () => new Map((statusesQ.data ?? []).map((s) => [s.id, s])),
    [statusesQ.data],
  )

  // The member's open tasks: assigned to them, not archived, not closed
  // (done/cancelled), not snoozed — dated ones first, then newest-first.
  const tasks = useMemo(
    () =>
      (tasksQ.data ?? [])
        .filter((t) => {
          const category = statusById.get(t.statusId ?? "")?.category
          return (
            t.assignee === userId &&
            !t.archivedAt &&
            category !== "done" &&
            category !== "cancelled" &&
            !isSnoozed(t, new Date())
          )
        })
        .sort((a, b) => {
          if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt)
          if (a.dueAt || b.dueAt) return a.dueAt ? -1 : 1
          return +new Date(b.createdAt) - +new Date(a.createdAt)
        })
        .slice(0, TASK_LIMIT),
    [tasksQ.data, statusById, userId],
  )

  // Recent activity = the newest org events this member authored. The event
  // feed has no actor filter server-side, so filter a recent window client-side.
  const eventsQ = useQuery({
    queryKey: ["events", null, "member", userId],
    queryFn: () => api.listEvents({ limit: 500 }),
    enabled: !!userId,
  })
  const events = useMemo(
    () => (eventsQ.data ?? []).filter((e) => e.actor === userId).slice(0, EVENT_LIMIT),
    [eventsQ.data, userId],
  )

  // A task points at its item lineage; the route wants an instance, so resolve
  // the head version (latest published, else the draft) on click.
  const open = useMutation({
    mutationFn: async (t: Task) => {
      if (!t.subjectId) return null
      const versions = [...(await api.listVersions(t.subjectId))].sort(
        (a, b) => b.versionSeq - a.versionSeq,
      )
      return versions.find((v) => v.versionStatus === "published") ?? versions[0] ?? null
    },
    onSuccess: (head) => head && navigate(`/instances/${head.id}`),
  })

  if (membersPending) return <Spinner />
  const member = members.find((m) => m.userId === userId)
  if (!member) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">
          No such member — they may have been removed from the org.
        </p>
      </Card>
    )
  }

  const label = memberLabel(member, userId)
  const email = member.user?.email
  const deactivated = deactivatedSet.has(userId)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex items-center gap-3">
        <Avatar className="size-12">
          <AvatarImage src={member.user?.image ?? undefined} alt="" />
          <AvatarFallback>{initialsOf(member.user?.name, email ?? userId)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-xl font-semibold text-foreground">{label}</h2>
            {deactivated && <Badge tone="red">deactivated</Badge>}
            <Badge tone={roleTone(member.role)}>{member.role}</Badge>
          </div>
          {email && (
            <a
              href={`mailto:${email}`}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              <Mail size={13} />
              {email}
            </a>
          )}
        </div>
      </header>

      <section className="space-y-3">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <ListTodo size={15} />
          Tasks
        </h3>
        {tasksQ.isLoading || statusesQ.isLoading ? (
          <Spinner />
        ) : tasks.length === 0 ? (
          <EmptyBox>No open tasks.</EmptyBox>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="divide-y divide-border">
              {tasks.map((t) => {
                const status = statusById.get(t.statusId ?? "")
                return (
                  <div key={t.id} className="flex items-center gap-2.5 px-4 py-3">
                    <button
                      type="button"
                      disabled={!t.subjectId || open.isPending}
                      onClick={() => open.mutate(t)}
                      className="min-w-0 flex-1 truncate text-left text-sm text-foreground enabled:cursor-pointer enabled:hover:underline"
                    >
                      {t.title}
                    </button>
                    {status && (
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <Dot status={status} />
                        {status.name}
                      </span>
                    )}
                    {t.dueAt && (
                      <span
                        className={`shrink-0 text-xs ${isOverdue(t.dueAt) ? "font-medium text-destructive" : "text-muted-foreground"}`}
                      >
                        {formatDateValue(t.dueAt)}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            {open.error && (
              <p className="px-4 pb-3 text-sm text-destructive">{(open.error as Error).message}</p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <Activity size={15} />
          Recent activity
        </h3>
        {eventsQ.isLoading ? (
          <Spinner />
        ) : events.length === 0 ? (
          <EmptyBox>No recent activity.</EmptyBox>
        ) : (
          <div className="rounded-xl border bg-card px-4 py-2 shadow-sm">
            <EventRows events={events} />
          </div>
        )}
      </section>
    </div>
  )
}

function EmptyBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[120px] items-center justify-center rounded-xl border border-dashed p-8">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  )
}
