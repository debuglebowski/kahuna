import { useLiveQuery } from "@tanstack/react-db"
import { useMutation } from "@tanstack/react-query"
import { ListTodo } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { isOverdue } from "@/components/item/DueDateControl"
import { Dot } from "@/components/item/StatusSelect"
import { Spinner } from "@/components/ui"
import { Checkbox } from "@/components/ui/checkbox"
import type { Task } from "@/lib/api"
import { api } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import {
  KEY,
  taskStatusesCollection,
  tasksGlobalCollection,
  useRegisterCollection,
} from "@/lib/collections"
import { formatDateValue } from "@/lib/dates"
import { recordHref } from "@/lib/recordHref"
import { openTasksFor } from "@/lib/taskGroups"
import { pickWelcome } from "@/lib/welcomeMessages"

/**
 * The landing page (`/`): a random big-title greeting plus the viewer's tasks.
 * "Mine" = open tasks from the global annotation layer (cross-item) assigned to
 * the session user — done and archived tasks drop off the list.
 */
export function Overview() {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const me = session?.user
  // Drawn once per visit; re-renders must not reshuffle the title.
  const [welcome] = useState(() => pickWelcome(me?.name))

  useRegisterCollection(KEY.tasksGlobal, tasksGlobalCollection)
  useRegisterCollection(KEY.taskStatuses, taskStatusesCollection)
  const tasksQ = useLiveQuery((q) => q.from({ t: tasksGlobalCollection }))
  const statusesQ = useLiveQuery((q) => q.from({ s: taskStatusesCollection }))

  const statuses = useMemo(
    () => [...(statusesQ.data ?? [])].sort((a, b) => a.position - b.position),
    [statusesQ.data],
  )
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses])
  const doneStatus = statuses.find((s) => s.category === "done" && !s.archivedAt)

  const mine = useMemo(() => {
    const uid = me?.id
    if (!uid) return []
    return openTasksFor(
      tasksQ.data ?? [],
      uid,
      (t) => statusById.get(t.statusId ?? "")?.category,
      new Date(),
    )
  }, [tasksQ.data, statusById, me?.id])

  const complete = useMutation({
    mutationFn: (t: Task) => api.setTaskStatus(t.id, t.version, doneStatus?.id ?? ""),
    onSuccess: () => tasksGlobalCollection.utils.refetch(),
  })
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
    onSuccess: (head) => head && navigate(recordHref(head.id)),
  })
  const err = complete.error ?? open.error

  const body = () => {
    if (tasksQ.isLoading || statusesQ.isLoading) return <Spinner />
    if (mine.length === 0)
      return <EmptyBox>Nothing assigned to you. Savor it while it lasts.</EmptyBox>
    return (
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="divide-y divide-border">
          {mine.map((t) => {
            const status = statusById.get(t.statusId ?? "")
            return (
              <div key={t.id} className="flex items-center gap-2.5 px-4 py-3">
                <Checkbox
                  aria-label="Mark done"
                  checked={false}
                  disabled={!doneStatus || complete.isPending}
                  onCheckedChange={(c) => c === true && complete.mutate(t)}
                />
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
        {err && <p className="px-4 pb-3 text-sm text-destructive">{(err as Error).message}</p>}
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-[80vh] w-full max-w-2xl flex-col justify-center gap-8">
      <h1 className="text-6xl leading-tight font-bold tracking-tight text-balance text-foreground">
        {welcome}
      </h1>
      <section className="space-y-3">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <ListTodo size={15} />
          My tasks
        </h2>
        {body()}
      </section>
    </div>
  )
}

function EmptyBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[160px] items-center justify-center rounded-xl border border-dashed p-8">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  )
}
