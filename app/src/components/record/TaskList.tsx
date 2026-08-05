import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Archive, ArchiveRestore, Maximize2, Plus, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { PrioritySelect } from "@/components/tasks/PriorityControl"
import { TaskModal } from "@/components/tasks/TaskModal"
import { Checkbox } from "@/components/ui/checkbox"
import type { Label, Task, TaskPriority, TaskStatus } from "../../lib/api"
import { api } from "../../lib/api"
import {
  KEY,
  taskPrioritiesCollection,
  taskStatusesCollection,
  tasksBySubject,
  useRegisterCollection,
} from "../../lib/collections"
import { isSnoozed } from "../../lib/taskGroups"
import { Badge, Button, ConfirmDialog, IconButton, Input } from "../ui"
import { AssigneePicker, type OrgMember } from "./AssigneePicker"
import { DueDateControl } from "./DueDateControl"
import { StatusSelect } from "./StatusSelect"

export function TaskComposer({ onCreate }: { onCreate: (title: string) => Promise<unknown> }) {
  const [title, setTitle] = useState("")
  const create = useMutation({
    mutationFn: () => onCreate(title.trim()),
    onSuccess: () => setTitle(""),
  })
  const submit = () => {
    if (title.trim()) create.mutate()
  }
  return (
    <div className="space-y-1.5 p-4">
      <div className="flex items-center gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Add a task…"
        />
        <Button onClick={submit} disabled={!title.trim() || create.isPending}>
          <Plus size={15} />
          {create.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
      {create.error && (
        <p className="text-sm text-destructive">{(create.error as Error).message}</p>
      )}
    </div>
  )
}

export function TaskItem({
  task,
  statuses,
  priorities,
  labels,
  members,
  canMutate,
  onSaved,
}: {
  task: Task
  statuses: ReadonlyArray<TaskStatus>
  priorities: ReadonlyArray<TaskPriority>
  labels: ReadonlyArray<Label>
  members: ReadonlyArray<OrgMember>
  canMutate: boolean
  onSaved: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  useEffect(() => setTitle(task.title), [task.title])

  const current = statuses.find((s) => s.id === task.statusId)
  const isDone = current?.category === "done"
  // Cancelled renders closed (struck) like done, but the checkbox only drives done.
  const isClosed = isDone || current?.category === "cancelled"
  const doneStatus = statuses.find((s) => s.category === "done" && !s.archivedAt)
  const openStatus =
    statuses.find((s) => s.isDefault && !s.archivedAt) ??
    statuses.find((s) => s.category !== "done" && s.category !== "cancelled" && !s.archivedAt)

  // Each mutation reuses the row's current version for optimistic concurrency; a
  // refetch reseeds it. Errors surface on the row.
  const saveTitle = useMutation({
    mutationFn: () => api.updateTask(task.id, task.version, { title: title.trim() }),
    onSuccess: onSaved,
  })
  const setStatusTo = useMutation({
    mutationFn: (statusId: string) => api.setTaskStatus(task.id, task.version, statusId),
    onSuccess: onSaved,
  })
  const assign = useMutation({
    mutationFn: (a: string | null) => api.assignTask(task.id, task.version, a),
    onSuccess: onSaved,
  })
  const setDue = useMutation({
    mutationFn: (iso: string | null) => api.updateTask(task.id, task.version, { dueAt: iso }),
    onSuccess: onSaved,
  })
  const setPriority = useMutation({
    mutationFn: (priorityId: string | null) =>
      api.updateTask(task.id, task.version, { priorityId }),
    onSuccess: onSaved,
  })
  const archive = useMutation({
    mutationFn: () =>
      task.archivedAt
        ? api.restoreTask(task.id, task.version)
        : api.archiveTask(task.id, task.version),
    onSuccess: onSaved,
  })
  const del = useMutation({ mutationFn: () => api.deleteTask(task.id), onSuccess: onSaved })

  const toggleDone = (checked: boolean) => {
    const target = checked ? doneStatus : openStatus
    if (target) setStatusTo.mutate(target.id)
  }

  const err =
    saveTitle.error ||
    setStatusTo.error ||
    assign.error ||
    setDue.error ||
    setPriority.error ||
    archive.error ||
    del.error

  return (
    <div className={`px-4 py-3 ${task.archivedAt ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-2.5">
        <Checkbox
          className="mt-1"
          checked={isDone}
          disabled={!canMutate || setStatusTo.isPending}
          onCheckedChange={(c) => toggleDone(c === true)}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <Input
            value={title}
            disabled={!canMutate}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== task.title && saveTitle.mutate()}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className={`h-8 border-transparent px-1 hover:border-input focus:border-input ${isClosed ? "text-muted-foreground line-through" : ""}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-40">
              <StatusSelect
                value={task.statusId}
                statuses={statuses}
                disabled={!canMutate}
                onChange={(s) => setStatusTo.mutate(s)}
              />
            </div>
            <div className="w-36">
              <PrioritySelect
                value={task.priorityId}
                priorities={priorities}
                disabled={!canMutate}
                onChange={(p) => setPriority.mutate(p)}
              />
            </div>
            <div className="w-44">
              <AssigneePicker
                value={task.assignee}
                members={members}
                disabled={!canMutate}
                onChange={(a) => assign.mutate(a)}
              />
            </div>
            <DueDateControl
              value={task.dueAt}
              disabled={!canMutate}
              onChange={(iso) => setDue.mutate(iso)}
            />
            {task.blockedAt && !isClosed && (
              <Badge tone="red">
                {task.blockedReason ? `Blocked · ${task.blockedReason}` : "Blocked"}
              </Badge>
            )}
            {isSnoozed(task, new Date()) && !isClosed && <Badge tone="amber">Snoozed</Badge>}
          </div>
          {err && <p className="text-sm text-destructive">{(err as Error).message}</p>}
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <IconButton aria-label="Open task details" onClick={() => setEditing(true)}>
            <Maximize2 size={14} />
          </IconButton>
          {canMutate && (
            <>
              <IconButton
                aria-label={task.archivedAt ? "Restore task" : "Archive task"}
                onClick={() => archive.mutate()}
              >
                {task.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              </IconButton>
              <IconButton aria-label="Delete task" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} />
              </IconButton>
            </>
          )}
        </span>
      </div>
      {editing && (
        <TaskModal
          task={task}
          statuses={statuses}
          priorities={priorities}
          labels={labels}
          members={members}
          canMutate={canMutate}
          onClose={() => setEditing(false)}
          onSaved={onSaved}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete task"
          message="Permanently delete this task? This can't be undone."
          confirmLabel="Delete"
          confirmVariant="danger"
          pending={del.isPending}
          error={del.error ? (del.error as Error).message : undefined}
          onConfirm={() => del.mutate()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}

/** Tasks for an item (subjectId = record id). Any member may add; the
 *  creator, assignee, or an admin may edit/complete/archive/delete. */
export function TaskList({
  subjectId,
  myUserId,
  isAdmin,
  members,
}: {
  subjectId: string
  myUserId: string | undefined
  isAdmin: boolean
  members: ReadonlyArray<OrgMember>
}) {
  const [showArchived, setShowArchived] = useState(false)
  const collection = tasksBySubject(subjectId)
  useRegisterCollection(KEY.tasks(subjectId), collection)
  useRegisterCollection(KEY.taskStatuses, taskStatusesCollection)
  useRegisterCollection(KEY.taskPriorities, taskPrioritiesCollection)
  const q = useLiveQuery((qb) => qb.from({ t: collection }), [subjectId, collection])
  const statusesQ = useLiveQuery((qb) => qb.from({ s: taskStatusesCollection }))
  const prioritiesQ = useLiveQuery((qb) => qb.from({ p: taskPrioritiesCollection }))
  const labelsQ = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
  const statuses = [...(statusesQ.data ?? [])].sort((a, b) => a.position - b.position)
  const priorities = [...(prioritiesQ.data ?? [])].sort((a, b) => a.position - b.position)
  const refetch = () => collection.utils.refetch()

  const all = [...(q.data ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  const tasks = showArchived ? all : all.filter((t) => !t.archivedAt)
  const archivedCount = all.length - all.filter((t) => !t.archivedAt).length

  const canMutate = (t: Task) =>
    isAdmin || (!!myUserId && (t.createdBy === myUserId || t.assignee === myUserId))

  return (
    <div>
      <TaskComposer onCreate={(title) => api.createTask({ subjectId, title }).then(refetch)} />
      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((s) => !s)}
          className="px-4 pb-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {showArchived ? "Hide" : "Show"} {archivedCount} archived
        </button>
      )}
      <div className="divide-y divide-border border-t border-border">
        {tasks.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">No tasks yet.</div>
        ) : (
          tasks.map((t) => (
            <TaskItem
              key={t.id}
              task={t}
              statuses={statuses}
              priorities={priorities}
              labels={labelsQ.data ?? []}
              members={members}
              canMutate={canMutate(t)}
              onSaved={refetch}
            />
          ))
        )}
      </div>
    </div>
  )
}
