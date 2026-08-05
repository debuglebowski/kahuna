import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery } from "@tanstack/react-query"
import { format } from "date-fns"
import {
  AlignLeft,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  MoreHorizontal,
  X,
} from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { MemberAvatar, memberLabel, type OrgMember } from "@/components/record/AssigneePicker"
import { isOverdue } from "@/components/record/DueDateControl"
import { Dot } from "@/components/record/StatusSelect"
import { TaskComposer } from "@/components/record/TaskList"
import { PriorityFlag } from "@/components/tasks/PriorityControl"
import { TaskModal } from "@/components/tasks/TaskModal"
import {
  Badge,
  ConfirmDialog,
  Input,
  LabelChip,
  Spinner,
  ToggleChip,
  Toolbar,
} from "@/components/ui"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Concept, Label, Task, TaskPriority, TaskStatus, TaskSubjectRef } from "@/lib/api"
import { api } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import {
  conceptsCollection,
  KEY,
  taskPrioritiesCollection,
  taskStatusesCollection,
  tasksGlobalCollection,
  useRegisterCollection,
} from "@/lib/collections"
import { parseDateValue } from "@/lib/dates"
import { ConceptIcon } from "@/lib/icons"
import { useMembers } from "@/lib/members"
import { recordHref } from "@/lib/recordHref"
import {
  daysOverdue,
  groupTasksBy,
  isSnoozed,
  matchesDue,
  type TaskGroup,
  type TaskGroupBy,
} from "@/lib/taskGroups"
import { useIsAdmin } from "@/pages/settings/SettingsLayout"

/** An assignee scope: "__all" | "__me" | "__none" | a member's userId. */
export type AssigneeScope = string

/** A row-metadata element the widget can toggle off. */
export type TaskRowMeta = "due" | "priority" | "labels" | "assignee"
const ALL_META: ReadonlyArray<TaskRowMeta> = ["due", "priority", "labels", "assignee"]

/**
 * The org-global task directory: every task — record-bound and org-level —
 * bucketed by schedule (Overdue / Today / Tomorrow / month / Not scheduled),
 * Zero-style (or by status / priority / flat via `groupBy`). Rows are dense
 * single-liners (Linear-style): status dot, assignee avatar and due date edit
 * inline via menus; rename, archive and delete live behind a hover-revealed
 * overflow menu. The composer at the top creates org-level (record-less)
 * tasks. Shared by the `/tasks` page and the `tasks` dashboard widget — the
 * props seed the (still runtime-interactive) toolbar state, toggle chrome the
 * widget may not have room for, and pin config-time filters (status / due /
 * concept). `variant: "checklist"` drops all chrome: flat borderless rows.
 */
export function TaskDirectory({
  defaultAssignee = "__all",
  showToolbar = true,
  showComposer = true,
  defaultShowDone = false,
  variant = "full",
  groupBy = "schedule",
  rowMeta = ALL_META,
  statusIds,
  due = "any",
  conceptId,
}: {
  defaultAssignee?: AssigneeScope
  showToolbar?: boolean
  showComposer?: boolean
  defaultShowDone?: boolean
  variant?: "full" | "checklist"
  groupBy?: TaskGroupBy
  rowMeta?: ReadonlyArray<TaskRowMeta>
  /** Config-time status filter; absent/empty = all statuses. */
  statusIds?: ReadonlyArray<string>
  due?: "any" | "overdue" | "week"
  /** Only tasks annotating that concept's records (via the subject refs). */
  conceptId?: string | null
}) {
  const { data: session } = useSession()
  const me = session?.user
  const { members, deactivatedSet } = useMembers()
  const { admin } = useIsAdmin()

  useRegisterCollection(KEY.tasksGlobal, tasksGlobalCollection)
  useRegisterCollection(KEY.taskStatuses, taskStatusesCollection)
  useRegisterCollection(KEY.taskPriorities, taskPrioritiesCollection)
  useRegisterCollection(KEY.concepts, conceptsCollection)
  const tasksQ = useLiveQuery((q) => q.from({ t: tasksGlobalCollection }))
  const statusesQ = useLiveQuery((q) => q.from({ s: taskStatusesCollection }))
  const prioritiesQ = useLiveQuery((q) => q.from({ p: taskPrioritiesCollection }))
  const conceptsQ = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  const labelsQ = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })

  const statuses = useMemo(
    () => [...(statusesQ.data ?? [])].sort((a, b) => a.position - b.position),
    [statusesQ.data],
  )
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses])
  const priorities = useMemo(
    () => [...(prioritiesQ.data ?? [])].sort((a, b) => a.position - b.position),
    [prioritiesQ.data],
  )
  const priorityById = useMemo(() => new Map(priorities.map((p) => [p.id, p])), [priorities])
  const labels = useMemo(() => labelsQ.data ?? [], [labelsQ.data])
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels])
  const conceptById = useMemo(
    () => new Map((conceptsQ.data ?? []).map((c) => [c.id, c])),
    [conceptsQ.data],
  )
  const memberByUserId = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members])

  // Record chips: one batched lookup for every distinct annotated item.
  const subjectIds = useMemo(
    () =>
      [...new Set((tasksQ.data ?? []).flatMap((t) => (t.subjectId ? [t.subjectId] : [])))].sort(),
    [tasksQ.data],
  )
  const refsQ = useQuery({
    queryKey: ["taskSubjects", subjectIds],
    queryFn: () => api.resolveTaskSubjects(subjectIds),
    enabled: subjectIds.length > 0,
  })
  const refBySubject = useMemo(
    () => new Map((refsQ.data ?? []).map((r) => [r.subjectId, r])),
    [refsQ.data],
  )

  const [filter, setFilter] = useState("")
  const [assignee, setAssignee] = useState(defaultAssignee)
  const [showDone, setShowDone] = useState(defaultShowDone)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<Task | null>(null)

  const isDone = useCallback(
    (t: Task) => statusById.get(t.statusId ?? "")?.category === "done",
    [statusById],
  )
  const isCancelled = useCallback(
    (t: Task) => statusById.get(t.statusId ?? "")?.category === "cancelled",
    [statusById],
  )
  const refetch = () => tasksGlobalCollection.utils.refetch()

  const statusIdSet = useMemo(
    () => (statusIds && statusIds.length > 0 ? new Set(statusIds) : null),
    [statusIds],
  )
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const now = new Date()
    return (tasksQ.data ?? []).filter((t) => {
      // The "Closed" toggle gates both closed categories (done + cancelled).
      if (!showDone && (isDone(t) || isCancelled(t))) return false
      if (assignee === "__me" && t.assignee !== me?.id) return false
      if (assignee === "__none" && t.assignee !== null) return false
      if (!assignee.startsWith("__") && t.assignee !== assignee) return false
      if (statusIdSet && !statusIdSet.has(t.statusId ?? "")) return false
      if (!matchesDue(t, due, now)) return false
      if (conceptId && refBySubject.get(t.subjectId ?? "")?.conceptId !== conceptId) return false
      if (q) {
        const record = t.subjectId ? (refBySubject.get(t.subjectId)?.label ?? "") : ""
        if (!t.title.toLowerCase().includes(q) && !record.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [
    tasksQ.data,
    isDone,
    isCancelled,
    refBySubject,
    filter,
    assignee,
    showDone,
    me?.id,
    statusIdSet,
    due,
    conceptId,
  ])

  const groups = useMemo(
    () =>
      groupTasksBy(
        shown,
        variant === "checklist" ? "none" : groupBy,
        { isDone, isCancelled },
        new Date(),
        statuses,
        priorities,
      ),
    [shown, variant, groupBy, isDone, isCancelled, statuses, priorities],
  )

  // Pickers drop deactivated members (the directory still badges them).
  const pickerMembers = useMemo(
    () => members.filter((m) => !deactivatedSet.has(m.userId)),
    [members, deactivatedSet],
  )

  const canMutate = (t: Task) =>
    admin || (!!me?.id && (t.createdBy === me.id || t.assignee === me.id))

  // The concept filter resolves through the subject refs — wait for them, or
  // every task flickers out before the refs arrive.
  if (
    tasksQ.isLoading ||
    statusesQ.isLoading ||
    (conceptId && subjectIds.length > 0 && refsQ.isLoading)
  )
    return <Spinner />

  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const checklist = variant === "checklist"
  const meta = new Set(rowMeta)

  return (
    <div className={checklist ? "space-y-1" : "space-y-4"}>
      {showToolbar && !checklist && (
        <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter tasks…">
          <Select value={assignee} onValueChange={setAssignee}>
            <SelectTrigger className="h-8 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Everyone</SelectItem>
              <SelectItem value="__me">Me</SelectItem>
              <SelectItem value="__none">Unassigned</SelectItem>
              {pickerMembers.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  {memberLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToggleChip pressed={showDone} onPressedChange={setShowDone}>
            Closed
          </ToggleChip>
        </Toolbar>
      )}

      {showComposer && !checklist && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <TaskComposer
            onCreate={(title) => api.createTask({ subjectId: null, title }).then(refetch)}
          />
        </div>
      )}

      {groups.length === 0 ? (
        checklist ? (
          <p className="text-sm text-muted-foreground">No tasks.</p>
        ) : (
          <div className="flex min-h-[160px] items-center justify-center rounded-xl border border-dashed p-8">
            <p className="text-sm text-muted-foreground">
              {(tasksQ.data ?? []).length === 0
                ? showComposer
                  ? "No tasks yet — add one above, or from any record's Tasks panel."
                  : "No tasks yet — add one from any record's Tasks panel."
                : "No tasks match the current filters."}
            </p>
          </div>
        )
      ) : (
        groups.map((g) => (
          <section key={g.key} className={checklist ? "" : "space-y-2"}>
            {/* The flat group ("all") carries no header — `none` grouping and
                the checklist variant render bare rows. */}
            {g.key !== "all" && (
              <button
                type="button"
                onClick={() => toggleCollapsed(g.key)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
                  g.tone === "overdue"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted/60 text-foreground"
                }`}
              >
                {collapsed.has(g.key) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                {g.title}
                <span className={g.tone === "overdue" ? "" : "text-muted-foreground"}>
                  {g.tasks.length}
                </span>
              </button>
            )}
            {!collapsed.has(g.key) && (
              <div
                className={
                  checklist
                    ? "divide-y divide-border/40"
                    : "divide-y divide-border/60 overflow-hidden rounded-xl border bg-card shadow-sm"
                }
              >
                {g.tasks.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    group={g}
                    status={statusById.get(t.statusId ?? "")}
                    statuses={statuses}
                    priority={priorityById.get(t.priorityId ?? "")}
                    priorities={priorities}
                    taskLabels={t.labelIds.flatMap((id) => {
                      const l = labelById.get(id)
                      return l ? [l] : []
                    })}
                    subjectRef={t.subjectId ? refBySubject.get(t.subjectId) : undefined}
                    concept={
                      t.subjectId
                        ? conceptById.get(refBySubject.get(t.subjectId)?.conceptId ?? "")
                        : undefined
                    }
                    assigneeMember={t.assignee ? memberByUserId.get(t.assignee) : undefined}
                    pickerMembers={pickerMembers}
                    canMutate={canMutate(t)}
                    meta={meta}
                    onSaved={refetch}
                    onEdit={() => setEditing(t)}
                  />
                ))}
              </div>
            )}
          </section>
        ))
      )}

      {editing && (
        <TaskModal
          key={editing.id}
          task={editing}
          statuses={statuses}
          priorities={priorities}
          labels={labels}
          members={pickerMembers}
          canMutate={canMutate(editing)}
          onClose={() => setEditing(null)}
          onSaved={refetch}
        />
      )}
    </div>
  )
}

/** "May 27", with the year only when it isn't the current one (Linear-style). */
const shortDate = (iso: string): string => {
  const d = parseDateValue(iso)
  if (!d) return ""
  return format(d, d.getFullYear() === new Date().getFullYear() ? "MMM d" : "MMM d, yyyy")
}

/**
 * One dense, Linear-style row: checkbox, status dot, title, then right-aligned
 * muted metadata (record, due date, assignee). Status/assignee/due edit in
 * place via dropdown/popover; rename/archive/delete hide behind a
 * hover-revealed overflow menu.
 */
function TaskRow({
  task,
  group,
  status,
  statuses,
  priority,
  priorities,
  taskLabels,
  subjectRef,
  concept,
  assigneeMember,
  pickerMembers,
  canMutate,
  meta,
  onSaved,
  onEdit,
}: {
  task: Task
  group: TaskGroup
  status: TaskStatus | undefined
  statuses: ReadonlyArray<TaskStatus>
  priority: TaskPriority | undefined
  priorities: ReadonlyArray<TaskPriority>
  taskLabels: ReadonlyArray<Label>
  subjectRef: TaskSubjectRef | undefined
  concept: Concept | undefined
  assigneeMember: OrgMember | undefined
  pickerMembers: ReadonlyArray<OrgMember>
  canMutate: boolean
  /** Which metadata elements render (the widget's row-meta toggles). */
  meta: ReadonlySet<TaskRowMeta>
  onSaved: () => void
  onEdit: () => void
}) {
  const done = status?.category === "done"
  // Cancelled renders closed (struck) like done, but the checkbox only drives done.
  const closed = done || status?.category === "cancelled"
  const doneStatus = statuses.find((s) => s.category === "done" && !s.archivedAt)
  const openStatus =
    statuses.find((s) => s.isDefault && !s.archivedAt) ??
    statuses.find((s) => s.category !== "done" && s.category !== "cancelled" && !s.archivedAt)
  const liveStatuses = statuses.filter((s) => !s.archivedAt)
  const livePriorities = priorities.filter((p) => !p.archivedAt)
  const snoozed = isSnoozed(task, new Date())

  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [dueOpen, setDueOpen] = useState(false)

  // Each mutation reuses the row's current version for optimistic concurrency;
  // the refetch reseeds it. Errors surface inline on the row.
  const toggle = useMutation({
    mutationFn: (checked: boolean) => {
      const target = checked ? doneStatus : openStatus
      if (!target) return Promise.resolve(null)
      return api.setTaskStatus(task.id, task.version, target.id)
    },
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
    onSuccess: () => {
      setDueOpen(false)
      onSaved()
    },
  })
  const setPriority = useMutation({
    mutationFn: (priorityId: string | null) =>
      api.updateTask(task.id, task.version, { priorityId }),
    onSuccess: onSaved,
  })
  const rename = useMutation({
    mutationFn: () => api.updateTask(task.id, task.version, { title: title.trim() }),
    onSuccess: () => {
      setRenaming(false)
      onSaved()
    },
  })
  const archive = useMutation({
    mutationFn: () => api.archiveTask(task.id, task.version),
    onSuccess: onSaved,
  })
  const del = useMutation({ mutationFn: () => api.deleteTask(task.id), onSuccess: onSaved })

  const err =
    toggle.error ??
    setStatusTo.error ??
    assign.error ??
    setDue.error ??
    setPriority.error ??
    rename.error ??
    archive.error ??
    del.error

  const saveRename = () => {
    if (title.trim() && title.trim() !== task.title) rename.mutate()
    else setRenaming(false)
  }

  const titleClass = `truncate text-sm ${closed ? "text-muted-foreground line-through" : "text-foreground"}`

  return (
    <div className="group flex h-9 items-center gap-2.5 px-3 hover:bg-accent/40">
      <Checkbox
        aria-label={done ? "Reopen task" : "Mark done"}
        checked={done}
        disabled={!canMutate || toggle.isPending || (!done && !doneStatus)}
        onCheckedChange={(c) => toggle.mutate(c === true)}
      />

      {/* status: icon-only dot, click to change */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!canMutate || setStatusTo.isPending}>
          <button
            type="button"
            title={status?.name ?? "Set status"}
            aria-label={status?.name ?? "Set status"}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm enabled:cursor-pointer enabled:hover:bg-accent"
          >
            {status ? (
              <Dot status={status} />
            ) : (
              <span className="size-2 rounded-full border border-muted-foreground/60" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {liveStatuses.map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => setStatusTo.mutate(s.id)}>
              <Dot status={s} />
              {s.name}
              {s.id === status?.id && <Check size={14} className="ml-auto" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* priority: flag, click to change (clearable) */}
      {meta.has("priority") && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={!canMutate || setPriority.isPending}>
            <button
              type="button"
              title={priority?.name ?? "Set priority"}
              aria-label={priority?.name ?? "Set priority"}
              className="flex size-5 shrink-0 items-center justify-center rounded-sm enabled:cursor-pointer enabled:hover:bg-accent"
            >
              <PriorityFlag priority={priority} size={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => setPriority.mutate(null)}>
              <PriorityFlag priority={null} />
              No priority
              {!task.priorityId && <Check size={14} className="ml-auto" />}
            </DropdownMenuItem>
            {livePriorities.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => setPriority.mutate(p.id)}>
                <PriorityFlag priority={p} />
                {p.name}
                {p.id === task.priorityId && <Check size={14} className="ml-auto" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* title (rename swaps in a borderless input) */}
      {renaming ? (
        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur()
            if (e.key === "Escape") {
              setTitle(task.title)
              setRenaming(false)
            }
          }}
          className="h-6 flex-1 border-transparent bg-transparent px-1 text-sm shadow-none"
        />
      ) : subjectRef?.recordVersionId ? (
        <Link
          to={recordHref(subjectRef.recordVersionId)}
          className={`min-w-0 ${titleClass} hover:underline`}
        >
          {task.title}
        </Link>
      ) : (
        // No record to route to — the title opens the task editor instead.
        <button
          type="button"
          onClick={onEdit}
          className={`min-w-0 ${titleClass} text-left hover:underline`}
        >
          {task.title}
        </button>
      )}
      {task.description && (
        <AlignLeft
          size={13}
          className="shrink-0 text-muted-foreground/60"
          aria-label="Has description"
        />
      )}
      {meta.has("labels") &&
        taskLabels.map((l) => (
          <LabelChip key={l.id} color={l.color} primary={l.primary}>
            {l.name}
          </LabelChip>
        ))}
      {task.blockedAt && !closed && (
        <Badge tone="red">
          {task.blockedReason ? `Blocked · ${task.blockedReason}` : "Blocked"}
        </Badge>
      )}
      {snoozed && task.snoozedUntil && !closed && (
        <Badge tone="amber">Snoozed · {shortDate(task.snoozedUntil)}</Badge>
      )}
      {err && <span className="shrink-0 text-xs text-destructive">{(err as Error).message}</span>}

      <span className="ml-auto flex shrink-0 items-center gap-2.5">
        {/* record (borderless, muted) */}
        {subjectRef &&
          (subjectRef.recordVersionId ? (
            <Link
              to={recordHref(subjectRef.recordVersionId)}
              className="flex max-w-44 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <ConceptIcon value={concept?.icon || "lucide:CircleDot"} size={13} />
              <span className="truncate">{subjectRef.label}</span>
            </Link>
          ) : (
            <span className="max-w-44 truncate text-xs text-muted-foreground/70">
              {subjectRef.label}
            </span>
          ))}

        {/* due date: text trigger, popover editor; bare calendar icon when unset */}
        {meta.has("due") && (
          <Popover open={dueOpen} onOpenChange={(o) => canMutate && setDueOpen(o)}>
            <PopoverTrigger asChild disabled={!canMutate && !task.dueAt}>
              <button
                type="button"
                aria-label="Set due date"
                className={`text-xs enabled:cursor-pointer ${
                  task.dueAt
                    ? group.key === "overdue" || isOverdue(task.dueAt)
                      ? "font-medium text-destructive"
                      : "text-muted-foreground enabled:hover:text-foreground"
                    : "text-muted-foreground/60 opacity-0 group-hover:opacity-100 enabled:hover:text-foreground data-[state=open]:opacity-100"
                }`}
              >
                {task.dueAt ? (
                  group.key === "overdue" ? (
                    `${daysOverdue(task.dueAt, new Date())}d`
                  ) : (
                    shortDate(task.dueAt)
                  )
                ) : (
                  <Calendar size={14} />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-2">
              <div className="flex items-center gap-1.5">
                <Input
                  type="date"
                  className="h-8 w-[9.5rem]"
                  value={task.dueAt ? task.dueAt.slice(0, 10) : ""}
                  disabled={setDue.isPending}
                  onChange={(e) =>
                    setDue.mutate(e.target.value ? new Date(e.target.value).toISOString() : null)
                  }
                />
                {task.dueAt && (
                  <button
                    type="button"
                    aria-label="Clear due date"
                    onClick={() => setDue.mutate(null)}
                    className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        )}

        {/* assignee: avatar trigger, member menu */}
        {meta.has("assignee") && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={!canMutate || assign.isPending}>
              <button
                type="button"
                title={assigneeMember ? memberLabel(assigneeMember) : "Assign"}
                aria-label={assigneeMember ? memberLabel(assigneeMember) : "Assign"}
                className="flex shrink-0 items-center enabled:cursor-pointer"
              >
                {assigneeMember ? (
                  <MemberAvatar member={assigneeMember} size={20} />
                ) : (
                  <CircleUserRound size={18} className="text-muted-foreground/50" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => assign.mutate(null)}>
                <CircleUserRound size={16} className="text-muted-foreground" />
                Unassigned
                {!task.assignee && <Check size={14} className="ml-auto" />}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {pickerMembers.map((m) => (
                <DropdownMenuItem key={m.userId} onSelect={() => assign.mutate(m.userId)}>
                  <MemberAvatar member={m} size={16} />
                  {memberLabel(m)}
                  {task.assignee === m.userId && <Check size={14} className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* overflow: edit / rename / archive / delete (hover-revealed) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Task actions"
              className="rounded-sm p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground data-[state=open]:opacity-100"
            >
              <MoreHorizontal size={15} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              {canMutate ? "Edit details" : "View details"}
            </DropdownMenuItem>
            {canMutate && (
              <>
                <DropdownMenuItem
                  onSelect={() => {
                    setTitle(task.title)
                    setRenaming(true)
                  }}
                >
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => archive.mutate()}>Archive</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>

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
