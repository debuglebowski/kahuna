import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Archive, ArchiveRestore, Check, GripVertical, Pencil, Plus, X } from "lucide-react"
import { useState } from "react"
import { useOutletContext } from "react-router-dom"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ColorSwatchPicker,
  ConfirmDialog,
  IconButton,
  Input,
  Modal,
  randomPillColor,
  Spinner,
  ToggleChip,
  Toolbar,
} from "../../components/ui"
import { api, type TaskPriority, type TaskStatus, type TaskStatusCategory } from "../../lib/api"
import { taskPrioritiesCollection, taskStatusesCollection } from "../../lib/collections"
import { Feedback } from "./parts"

/** Display metadata per status category (the category carries completion
 *  semantics — grouping, the done checkbox — so nothing keys off the name). */
const CATEGORIES: ReadonlyArray<{
  value: TaskStatusCategory
  label: string
  tone: "gray" | "blue" | "green" | "red"
}> = [
  { value: "todo", label: "To do", tone: "gray" },
  { value: "active", label: "Active", tone: "blue" },
  { value: "done", label: "Done", tone: "green" },
  { value: "cancelled", label: "Cancelled", tone: "red" },
]

const categoryMeta = (c: TaskStatusCategory) => CATEGORIES.find((m) => m.value === c)!

/** Map engine errors to a short message for the vocabulary dialogs. Engine
 *  errors arrive with their field payload as the message (no human text), so we
 *  branch on the payload shape: `reason`/`taskCount` ⇒ in-use, `name` ⇒ conflict. */
function vocabMsg(e: unknown, noun: "status" | "priority"): string {
  const m = (e as Error)?.message ?? ""
  let p: Record<string, unknown> | null = null
  try {
    p = JSON.parse(m) as Record<string, unknown>
  } catch {
    p = null
  }
  if (p && typeof p.reason === "string") {
    if (p.reason === "default")
      return "The default status can't be archived — make another status the default first."
    if (p.reason === "last-in-category")
      return "This is the last status in its category — tasks there would have nowhere to live."
    return "Live tasks still use this status — move them to another status first."
  }
  if (p && typeof p.taskCount === "number")
    return `Live tasks still use this ${noun} — move them first.`
  if (p && typeof p.name === "string") return `A ${noun} with that name already exists.`
  if (m.includes("FORBIDDEN") || m.includes("Admin only")) return "Admins only."
  return m || "Something went wrong."
}

function ColorDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className={`size-2.5 shrink-0 rounded-full${color ? "" : " bg-muted-foreground/50"}`}
      style={color ? { background: color } : undefined}
    />
  )
}

/** A vocabulary row — dot + name + badges, draggable to reorder (admins, while
 *  the list is unfiltered and live-only so positions stay meaningful). */
function VocabRow({
  id,
  name,
  color,
  archived,
  badges,
  sortable,
  onEdit,
}: {
  id: string
  name: string
  color: string | null
  archived: boolean
  badges?: React.ReactNode
  sortable: boolean
  onEdit?: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !sortable,
  })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 px-6 py-3 ${isDragging ? "opacity-60 shadow" : ""}${
        archived ? " opacity-60" : ""
      }`}
    >
      <button
        type="button"
        className={
          sortable
            ? "cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
            : "cursor-default text-muted-foreground/40"
        }
        aria-label="Drag to reorder"
        disabled={!sortable}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      <ColorDot color={color} />
      <span className="truncate text-sm font-medium text-foreground">{name}</span>
      {badges}
      {archived && <Badge tone="amber">archived</Badge>}
      <span className="flex-1" />
      {onEdit && (
        <IconButton aria-label={`Edit ${name}`} onClick={onEdit}>
          <Pencil size={15} />
        </IconButton>
      )}
    </li>
  )
}

// ── statuses ─────────────────────────────────────────────────────────────────

/** Shared name / category / color fields for the status create and edit modals. */
function StatusFields({
  name,
  setName,
  category,
  setCategory,
  color,
  setColor,
  onSubmit,
  disabled = false,
}: {
  name: string
  setName: (v: string) => void
  category: TaskStatusCategory
  setCategory: (v: TaskStatusCategory) => void
  color: string
  setColor: (v: string) => void
  onSubmit?: () => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <span className="block text-sm leading-none font-medium text-foreground">Name</span>
        <Input
          autoFocus
          value={name}
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit?.()
          }}
          placeholder="e.g. In review"
        />
      </div>
      <div className="space-y-1.5">
        <span className="block text-sm leading-none font-medium text-foreground">Category</span>
        <Select
          value={category}
          onValueChange={(v) => setCategory(v as TaskStatusCategory)}
          disabled={disabled}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Determines grouping and what the done checkbox does — the name is just a label. Done marks
          tasks completed; Cancelled closes them without completing.
        </p>
      </div>
      <div className="space-y-1.5">
        <span className="block text-sm leading-none font-medium text-foreground">Color</span>
        <ColorSwatchPicker label="Status color" value={color || null} onChange={setColor} />
      </div>
    </div>
  )
}

/** Create a new status in a modal (editing happens in {@link StatusModal}). */
function CreateStatusModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("")
  const [category, setCategory] = useState<TaskStatusCategory>("todo")
  const [color, setColor] = useState(() => randomPillColor())

  const save = useMutation({
    mutationFn: () =>
      api.createTaskStatus({ name: name.trim(), category, color: color.trim() || null }),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })
  const submit = () => {
    if (name.trim()) save.mutate()
  }

  return (
    <Modal title="New status" onClose={onClose}>
      <div className="space-y-3">
        <StatusFields
          name={name}
          setName={setName}
          category={category}
          setCategory={setCategory}
          color={color}
          setColor={setColor}
          onSubmit={submit}
        />
        <div className="flex gap-2">
          <Button onClick={submit} disabled={save.isPending || !name.trim()}>
            <Check size={15} />
            {save.isPending ? "Saving…" : "Create"}
          </Button>
          <Button variant="outline" onClick={onClose}>
            <X size={15} />
            Cancel
          </Button>
        </div>
        <Feedback error={save.error ? new Error(vocabMsg(save.error, "status")) : undefined} />
      </div>
    </Modal>
  )
}

/** Edit a status in a modal: the form, a make-default action, and a Danger zone
 *  (archive/restore — statuses are never hard-deleted; tasks reference them). */
function StatusModal({
  status,
  admin,
  onClose,
  onSaved,
  onArchive,
  onRestore,
  restorePending,
  restoreError,
}: {
  status: TaskStatus
  admin: boolean
  onClose: () => void
  onSaved: () => void
  onArchive: () => void
  onRestore: () => void
  restorePending: boolean
  restoreError?: string
}) {
  const [name, setName] = useState(status.name)
  const [category, setCategory] = useState<TaskStatusCategory>(status.category)
  // No color stays empty → the picker shows no selection and save keeps null.
  const [color, setColor] = useState(status.color ?? "")

  const save = useMutation({
    mutationFn: () =>
      api.updateTaskStatus({
        id: status.id,
        name: name.trim(),
        category,
        color: color.trim() || null,
      }),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })
  // One-way by design: the server keeps exactly one live default, so demoting
  // happens by promoting another status, never by un-setting this one.
  const makeDefault = useMutation({
    mutationFn: () => api.updateTaskStatus({ id: status.id, isDefault: true }),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })
  const submit = () => {
    if (name.trim()) save.mutate()
  }

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <ColorDot color={status.color} />
          {status.name}
        </span>
      }
      onClose={onClose}
    >
      <div className="space-y-5">
        <div className="space-y-3">
          <StatusFields
            name={name}
            setName={setName}
            category={category}
            setCategory={setCategory}
            color={color}
            setColor={setColor}
            onSubmit={submit}
            disabled={!admin}
          />
          {admin && (
            <div className="flex gap-2">
              <Button onClick={submit} disabled={save.isPending || !name.trim()}>
                <Check size={15} />
                {save.isPending ? "Saving…" : "Save"}
              </Button>
              <Button variant="outline" onClick={onClose}>
                <X size={15} />
                Cancel
              </Button>
            </div>
          )}
          <Feedback error={save.error ? new Error(vocabMsg(save.error, "status")) : undefined} />
        </div>

        {admin && !status.archivedAt && (
          <div className="flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Default status</p>
              <p className="text-xs text-muted-foreground">New tasks start in this status.</p>
            </div>
            {status.isDefault ? (
              <Badge tone="blue">Default</Badge>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={makeDefault.isPending}
                onClick={() => makeDefault.mutate()}
              >
                {makeDefault.isPending ? "Saving…" : "Make default"}
              </Button>
            )}
          </div>
        )}
        <Feedback
          error={makeDefault.error ? new Error(vocabMsg(makeDefault.error, "status")) : undefined}
        />

        {admin && (
          <DangerZone
            archived={status.archivedAt !== null}
            archiveHint="Hides it from pickers. Blocked while it's the default, the last in its category, or live tasks use it."
            onArchive={onArchive}
            onRestore={onRestore}
            restorePending={restorePending}
            restoreError={restoreError}
            noun="status"
          />
        )}
      </div>
    </Modal>
  )
}

// ── priorities ───────────────────────────────────────────────────────────────

/** Shared name / color fields for the priority create and edit modals. */
function PriorityFields({
  name,
  setName,
  color,
  setColor,
  onSubmit,
  disabled = false,
}: {
  name: string
  setName: (v: string) => void
  color: string
  setColor: (v: string) => void
  onSubmit?: () => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <span className="block text-sm leading-none font-medium text-foreground">Name</span>
        <Input
          autoFocus
          value={name}
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit?.()
          }}
          placeholder="e.g. Critical"
        />
      </div>
      <div className="space-y-1.5">
        <span className="block text-sm leading-none font-medium text-foreground">Color</span>
        <ColorSwatchPicker label="Priority color" value={color || null} onChange={setColor} />
      </div>
    </div>
  )
}

/** Create a new priority in a modal (editing happens in {@link PriorityModal}). */
function CreatePriorityModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("")
  const [color, setColor] = useState(() => randomPillColor())

  const save = useMutation({
    mutationFn: () => api.createTaskPriority({ name: name.trim(), color: color.trim() || null }),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })
  const submit = () => {
    if (name.trim()) save.mutate()
  }

  return (
    <Modal title="New priority" onClose={onClose}>
      <div className="space-y-3">
        <PriorityFields
          name={name}
          setName={setName}
          color={color}
          setColor={setColor}
          onSubmit={submit}
        />
        <div className="flex gap-2">
          <Button onClick={submit} disabled={save.isPending || !name.trim()}>
            <Check size={15} />
            {save.isPending ? "Saving…" : "Create"}
          </Button>
          <Button variant="outline" onClick={onClose}>
            <X size={15} />
            Cancel
          </Button>
        </div>
        <Feedback error={save.error ? new Error(vocabMsg(save.error, "priority")) : undefined} />
      </div>
    </Modal>
  )
}

/** Edit a priority in a modal: the form plus a Danger zone (archive/restore). */
function PriorityModal({
  priority,
  admin,
  onClose,
  onSaved,
  onArchive,
  onRestore,
  restorePending,
  restoreError,
}: {
  priority: TaskPriority
  admin: boolean
  onClose: () => void
  onSaved: () => void
  onArchive: () => void
  onRestore: () => void
  restorePending: boolean
  restoreError?: string
}) {
  const [name, setName] = useState(priority.name)
  const [color, setColor] = useState(priority.color ?? "")

  const save = useMutation({
    mutationFn: () =>
      api.updateTaskPriority({ id: priority.id, name: name.trim(), color: color.trim() || null }),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })
  const submit = () => {
    if (name.trim()) save.mutate()
  }

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <ColorDot color={priority.color} />
          {priority.name}
        </span>
      }
      onClose={onClose}
    >
      <div className="space-y-5">
        <div className="space-y-3">
          <PriorityFields
            name={name}
            setName={setName}
            color={color}
            setColor={setColor}
            onSubmit={submit}
            disabled={!admin}
          />
          {admin && (
            <div className="flex gap-2">
              <Button onClick={submit} disabled={save.isPending || !name.trim()}>
                <Check size={15} />
                {save.isPending ? "Saving…" : "Save"}
              </Button>
              <Button variant="outline" onClick={onClose}>
                <X size={15} />
                Cancel
              </Button>
            </div>
          )}
          <Feedback error={save.error ? new Error(vocabMsg(save.error, "priority")) : undefined} />
        </div>

        {admin && (
          <DangerZone
            archived={priority.archivedAt !== null}
            archiveHint="Hides it from pickers. Blocked while live tasks use it."
            onArchive={onArchive}
            onRestore={onRestore}
            restorePending={restorePending}
            restoreError={restoreError}
            noun="priority"
          />
        )}
      </div>
    </Modal>
  )
}

/** The archive/restore Danger zone shared by both vocabulary modals. */
function DangerZone({
  archived,
  archiveHint,
  onArchive,
  onRestore,
  restorePending,
  restoreError,
  noun,
}: {
  archived: boolean
  archiveHint: string
  onArchive: () => void
  onRestore: () => void
  restorePending: boolean
  restoreError?: string
  noun: string
}) {
  return (
    <Card className="border-destructive/40">
      <CardHeader
        title={<span className="text-destructive">Danger zone</span>}
        action={archived ? <Badge tone="amber">Archived</Badge> : undefined}
      />
      <div className="divide-y divide-border">
        {archived ? (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Restore this {noun}</p>
              <p className="text-xs text-muted-foreground">Brings it back to pickers.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={restorePending}
              onClick={onRestore}
            >
              <ArchiveRestore size={14} />
              {restorePending ? "Restoring…" : "Restore"}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Archive this {noun}</p>
              <p className="text-xs text-muted-foreground">{archiveHint}</p>
            </div>
            <Button variant="outline" size="sm" className="shrink-0" onClick={onArchive}>
              <Archive size={14} />
              Archive
            </Button>
          </div>
        )}
      </div>
      {restoreError && <p className="px-4 pb-3 text-sm text-destructive">{restoreError}</p>}
    </Card>
  )
}

// ── sections ─────────────────────────────────────────────────────────────────

function StatusesSection({ admin }: { admin: boolean }) {
  const qc = useQueryClient()
  // Distinct key from the live taskStatusesCollection read app-wide — the
  // editor needs archived too. Mutations refresh both.
  const statuses = useQuery({
    queryKey: ["taskStatuses", "withArchived"],
    queryFn: () => api.listTaskStatuses({ includeArchived: true }),
  })
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<TaskStatus | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [filter, setFilter] = useState("")
  const [archiving, setArchiving] = useState<TaskStatus | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["taskStatuses"] })
    void taskStatusesCollection.utils.refetch()
  }

  const archive = useMutation({
    mutationFn: (id: string) => api.archiveTaskStatus(id),
    onSuccess: () => {
      setArchiving(null)
      setEditing(null)
      invalidate()
    },
  })
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreTaskStatus(id),
    onSuccess: () => {
      setEditing(null)
      invalidate()
    },
  })
  const reorder = useMutation({
    mutationFn: (orders: { id: string; position: number }[]) => api.reorderTaskStatuses(orders),
    onSuccess: invalidate,
  })

  if (statuses.isPending) return <Spinner />
  if (statuses.error)
    return <p className="text-sm text-destructive">{(statuses.error as Error).message}</p>

  const sorted = [...(statuses.data ?? [])].sort((a, b) => a.position - b.position)
  const live = sorted.filter((s) => !s.archivedAt)
  const archived = sorted.filter((s) => s.archivedAt)
  // The stale toggle state must not linger once the last archived status is
  // restored (the chip disappears, so it couldn't be turned off anymore).
  const showingArchived = showArchived && archived.length > 0
  const q = filter.trim().toLowerCase()
  const rows = sorted.filter(
    (s) => (showingArchived || !s.archivedAt) && s.name.toLowerCase().includes(q),
  )
  // Reorder works over live positions, so it's off while a filter or the
  // archived rows would make the dragged list diverge from what's saved.
  const sortable = admin && !q && !showingArchived

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = live.findIndex((s) => s.id === active.id)
    const to = live.findIndex((s) => s.id === over.id)
    if (from < 0 || to < 0) return
    const next = arrayMove(live, from, to)
    reorder.mutate(next.map((s, i) => ({ id: s.id, position: i })))
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-base font-semibold text-foreground">Statuses</h3>
        <p className="text-sm text-muted-foreground">
          The statuses a task moves through. Their order here is the picker order; the default is
          applied to new tasks.
        </p>
      </div>
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter statuses…">
        {admin && archived.length > 0 && (
          <ToggleChip pressed={showArchived} onPressedChange={setShowArchived}>
            Archived ({archived.length})
          </ToggleChip>
        )}
        {admin && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={15} />
            New status
          </Button>
        )}
      </Toolbar>

      {creating && <CreateStatusModal onClose={() => setCreating(false)} onSaved={invalidate} />}
      {editing && (
        <StatusModal
          key={editing.id}
          status={editing}
          admin={admin}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
          onArchive={() => setArchiving(editing)}
          onRestore={() => restore.mutate(editing.id)}
          restorePending={restore.isPending}
          restoreError={restore.error ? vocabMsg(restore.error, "status") : undefined}
        />
      )}

      <Card>
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {q
              ? `No statuses match "${filter.trim()}".`
              : "No statuses yet — they define the stages a task moves through."}
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={rows.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <ul className="divide-y divide-border">
                {rows.map((s) => {
                  const cat = categoryMeta(s.category)
                  return (
                    <VocabRow
                      key={s.id}
                      id={s.id}
                      name={s.name}
                      color={s.color}
                      archived={s.archivedAt !== null}
                      badges={
                        <>
                          <Badge tone={cat.tone}>{cat.label}</Badge>
                          {s.isDefault && <Badge tone="blue">Default</Badge>}
                        </>
                      }
                      sortable={sortable}
                      onEdit={admin ? () => setEditing(s) : undefined}
                    />
                  )
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </Card>

      {archiving && (
        <ConfirmDialog
          title="Archive status"
          message={
            <>
              Archive <strong>{archiving.name}</strong>? It drops out of pickers — you can restore
              it anytime.
            </>
          }
          confirmLabel="Archive"
          pending={archive.isPending}
          error={archive.error ? vocabMsg(archive.error, "status") : undefined}
          onConfirm={() => archive.mutate(archiving.id)}
          onCancel={() => setArchiving(null)}
        />
      )}
    </div>
  )
}

function PrioritiesSection({ admin }: { admin: boolean }) {
  const qc = useQueryClient()
  const priorities = useQuery({
    queryKey: ["taskPriorities", "withArchived"],
    queryFn: () => api.listTaskPriorities({ includeArchived: true }),
  })
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<TaskPriority | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [filter, setFilter] = useState("")
  const [archiving, setArchiving] = useState<TaskPriority | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["taskPriorities"] })
    void taskPrioritiesCollection.utils.refetch()
  }

  const archive = useMutation({
    mutationFn: (id: string) => api.archiveTaskPriority(id),
    onSuccess: () => {
      setArchiving(null)
      setEditing(null)
      invalidate()
    },
  })
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreTaskPriority(id),
    onSuccess: () => {
      setEditing(null)
      invalidate()
    },
  })
  const reorder = useMutation({
    mutationFn: (orders: { id: string; position: number }[]) => api.reorderTaskPriorities(orders),
    onSuccess: invalidate,
  })

  if (priorities.isPending) return <Spinner />
  if (priorities.error)
    return <p className="text-sm text-destructive">{(priorities.error as Error).message}</p>

  const sorted = [...(priorities.data ?? [])].sort((a, b) => a.position - b.position)
  const live = sorted.filter((p) => !p.archivedAt)
  const archived = sorted.filter((p) => p.archivedAt)
  const showingArchived = showArchived && archived.length > 0
  const q = filter.trim().toLowerCase()
  const rows = sorted.filter(
    (p) => (showingArchived || !p.archivedAt) && p.name.toLowerCase().includes(q),
  )
  const sortable = admin && !q && !showingArchived

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = live.findIndex((p) => p.id === active.id)
    const to = live.findIndex((p) => p.id === over.id)
    if (from < 0 || to < 0) return
    const next = arrayMove(live, from, to)
    reorder.mutate(next.map((p, i) => ({ id: p.id, position: i })))
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-base font-semibold text-foreground">Priorities</h3>
        <p className="text-sm text-muted-foreground">
          The priority scale for tasks, most urgent first. New tasks start with no priority.
        </p>
      </div>
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter priorities…">
        {admin && archived.length > 0 && (
          <ToggleChip pressed={showArchived} onPressedChange={setShowArchived}>
            Archived ({archived.length})
          </ToggleChip>
        )}
        {admin && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={15} />
            New priority
          </Button>
        )}
      </Toolbar>

      {creating && <CreatePriorityModal onClose={() => setCreating(false)} onSaved={invalidate} />}
      {editing && (
        <PriorityModal
          key={editing.id}
          priority={editing}
          admin={admin}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
          onArchive={() => setArchiving(editing)}
          onRestore={() => restore.mutate(editing.id)}
          restorePending={restore.isPending}
          restoreError={restore.error ? vocabMsg(restore.error, "priority") : undefined}
        />
      )}

      <Card>
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {q
              ? `No priorities match "${filter.trim()}".`
              : "No priorities yet — add a scale like Urgent / High / Medium / Low."}
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={rows.map((p) => p.id)} strategy={verticalListSortingStrategy}>
              <ul className="divide-y divide-border">
                {rows.map((p) => (
                  <VocabRow
                    key={p.id}
                    id={p.id}
                    name={p.name}
                    color={p.color}
                    archived={p.archivedAt !== null}
                    sortable={sortable}
                    onEdit={admin ? () => setEditing(p) : undefined}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </Card>

      {archiving && (
        <ConfirmDialog
          title="Archive priority"
          message={
            <>
              Archive <strong>{archiving.name}</strong>? It drops out of pickers — you can restore
              it anytime.
            </>
          }
          confirmLabel="Archive"
          pending={archive.isPending}
          error={archive.error ? vocabMsg(archive.error, "priority") : undefined}
          onConfirm={() => archive.mutate(archiving.id)}
          onCancel={() => setArchiving(null)}
        />
      )}
    </div>
  )
}

export function Tasks() {
  const { admin } = useOutletContext<{ admin: boolean }>()
  return (
    <div className="space-y-8">
      <StatusesSection admin={admin} />
      <PrioritiesSection admin={admin} />
    </div>
  )
}
