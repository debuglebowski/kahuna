import { useMutation, useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useState } from "react"
import { RichTextEditor } from "@/components/editor/RichTextEditor"
import { AssigneePicker, type OrgMember } from "@/components/item/AssigneePicker"
import { DueDateControl } from "@/components/item/DueDateControl"
import { StatusSelect } from "@/components/item/StatusSelect"
import { LabelMultiSelect } from "@/components/LabelMultiSelect"
import { Badge, Button, ConfirmDialog, Field, IconButton, Input } from "@/components/ui"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Label, RichTextEnvelope, Task, TaskPriority, TaskStatus } from "@/lib/api"
import { api } from "@/lib/api"
import { isRichTextEmpty, type RichTextValue } from "@/lib/richtext"
import { PrioritySelect } from "./PriorityControl"

/** Sentinel for "no blocking task" (Select can't carry a null item value). */
const NO_TASK = "__none"

/**
 * The full task editor — the home for everything the dense rows have no room
 * for (description, priority, labels, snooze, blocked). Draft + Save with a
 * discard confirm (the ViewEditor pattern); the quick inline controls on the
 * rows stay the fast path. Saving chains the discrete RPCs (update / status /
 * assign / snooze / block), threading the bumped version through.
 */
export function TaskModal({
  task,
  statuses,
  priorities,
  labels,
  members,
  canMutate,
  onClose,
  onSaved,
}: {
  task: Task
  statuses: ReadonlyArray<TaskStatus>
  priorities: ReadonlyArray<TaskPriority>
  labels: ReadonlyArray<Label>
  members: ReadonlyArray<OrgMember>
  canMutate: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState<RichTextValue | null>(
    task.description as RichTextValue | null,
  )
  const [statusId, setStatusId] = useState(task.statusId)
  const [priorityId, setPriorityId] = useState(task.priorityId)
  const [assignee, setAssignee] = useState(task.assignee)
  const [dueAt, setDueAt] = useState(task.dueAt)
  const [labelIds, setLabelIds] = useState<ReadonlyArray<string>>(task.labelIds)
  const [snoozedUntil, setSnoozedUntil] = useState(task.snoozedUntil)
  const [blockedOn, setBlockedOn] = useState(task.blockedAt !== null)
  const [blockedReason, setBlockedReason] = useState(task.blockedReason ?? "")
  const [blockedByTaskId, setBlockedByTaskId] = useState(task.blockedByTaskId)
  const [dirty, setDirty] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)

  // Every edit goes through one of these so the discard confirm only fires
  // when the draft actually diverged.
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v)
      setDirty(true)
    }

  // Candidate blockers, loaded once the section is relevant (live, not self).
  const blockerPick = useQuery({
    queryKey: ["taskBlockerPick"],
    queryFn: () => api.listTasks({ limit: 500 }),
    enabled: blockedOn,
  })
  const blockerOptions = (blockerPick.data ?? []).filter((t) => t.id !== task.id)
  const blocker = blockerOptions.find((t) => t.id === blockedByTaskId)

  const save = useMutation({
    mutationFn: async () => {
      let version = task.version
      const bump = (t: Task) => {
        version = t.version
      }

      // The normalized description: an all-whitespace doc saves as null.
      const desc =
        description && !isRichTextEmpty(description)
          ? (description as unknown as RichTextEnvelope)
          : null
      const descChanged =
        JSON.stringify(desc?.doc ?? null) !== JSON.stringify(task.description?.doc ?? null)
      const labelsChanged =
        labelIds.length !== task.labelIds.length ||
        labelIds.some((id) => !task.labelIds.includes(id))

      const patch: Parameters<typeof api.updateTask>[2] = {}
      if (title.trim() && title.trim() !== task.title) patch.title = title.trim()
      if (descChanged) patch.description = desc
      if (priorityId !== task.priorityId) patch.priorityId = priorityId
      if (labelsChanged) patch.labelIds = labelIds
      if (dueAt !== task.dueAt) patch.dueAt = dueAt
      if (Object.keys(patch).length > 0) bump(await api.updateTask(task.id, version, patch))

      if (statusId !== task.statusId && statusId)
        bump(await api.setTaskStatus(task.id, version, statusId))
      if (assignee !== task.assignee) bump(await api.assignTask(task.id, version, assignee))
      if (snoozedUntil !== task.snoozedUntil)
        bump(await api.snoozeTask(task.id, version, snoozedUntil))

      const wasBlocked = task.blockedAt !== null
      const blockedChanged =
        blockedOn !== wasBlocked ||
        (blockedOn &&
          ((blockedReason.trim() || null) !== task.blockedReason ||
            blockedByTaskId !== task.blockedByTaskId))
      if (blockedChanged) {
        await api.setTaskBlocked(
          task.id,
          version,
          blockedOn ? { reason: blockedReason.trim() || null, taskId: blockedByTaskId } : null,
        )
      }
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })

  const requestClose = () => (dirty ? setConfirmingClose(true) : onClose())

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3">
          <DialogTitle className="truncate text-base">{title.trim() || "Edit task"}</DialogTitle>
          <div className="flex shrink-0 items-center gap-2">
            {save.error && (
              <p className="max-w-md text-xs text-destructive">{(save.error as Error).message}</p>
            )}
            <Button variant="outline" onClick={requestClose}>
              {canMutate ? "Cancel" : "Close"}
            </Button>
            {canMutate && (
              <Button onClick={() => save.mutate()} disabled={save.isPending || !title.trim()}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          <Field label="Title">
            <Input
              value={title}
              disabled={!canMutate}
              onChange={(e) => edit(setTitle)(e.target.value)}
              placeholder="Task title…"
            />
          </Field>

          <Field label="Description">
            <div className="rounded-md border border-input">
              <RichTextEditor
                value={description}
                editable={canMutate}
                placeholder="Add a description…"
                onChange={edit(setDescription)}
              />
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <StatusSelect
                value={statusId}
                statuses={statuses}
                disabled={!canMutate}
                onChange={edit(setStatusId)}
              />
            </Field>
            <Field label="Priority">
              <PrioritySelect
                value={priorityId}
                priorities={priorities}
                disabled={!canMutate}
                onChange={edit(setPriorityId)}
              />
            </Field>
            <Field label="Assignee">
              <AssigneePicker
                value={assignee}
                members={members}
                disabled={!canMutate}
                onChange={edit(setAssignee)}
              />
            </Field>
            <Field label="Due date">
              <DueDateControl value={dueAt} disabled={!canMutate} onChange={edit(setDueAt)} />
            </Field>
          </div>

          <Field label="Labels">
            <LabelMultiSelect
              all={canMutate ? labels : labels.filter((l) => labelIds.includes(l.id))}
              selectedIds={labelIds}
              onChange={(ids) => canMutate && edit(setLabelIds)(ids)}
              emptyHint="No labels in the vocabulary yet — add some in Settings → Labels."
            />
          </Field>

          <Field label="Snooze">
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                className="h-8 w-[9.5rem]"
                value={snoozedUntil ? snoozedUntil.slice(0, 10) : ""}
                disabled={!canMutate}
                onChange={(e) =>
                  edit(setSnoozedUntil)(
                    e.target.value ? new Date(e.target.value).toISOString() : null,
                  )
                }
              />
              {snoozedUntil && <Badge tone="amber">Snoozed</Badge>}
              {snoozedUntil && canMutate && (
                <IconButton aria-label="Clear snooze" onClick={() => edit(setSnoozedUntil)(null)}>
                  <X size={14} />
                </IconButton>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Hidden from open-task lists until this date.
            </p>
          </Field>

          <div className="space-y-3 rounded-md border border-border p-4">
            <label
              htmlFor="task-blocked"
              className="flex items-center gap-2 text-sm font-medium text-foreground"
            >
              <Checkbox
                id="task-blocked"
                checked={blockedOn}
                disabled={!canMutate}
                onCheckedChange={(c) => edit(setBlockedOn)(c === true)}
              />
              Blocked
              {task.blockedAt && blockedOn && <Badge tone="red">Blocked</Badge>}
            </label>
            {blockedOn && (
              <div className="space-y-3 pl-6">
                <Field label="Reason">
                  <Input
                    value={blockedReason}
                    disabled={!canMutate}
                    onChange={(e) => edit(setBlockedReason)(e.target.value)}
                    placeholder="What's blocking this?"
                  />
                </Field>
                <Field label="Blocked by task">
                  <Select
                    value={blockedByTaskId ?? NO_TASK}
                    disabled={!canMutate}
                    onValueChange={(v) => edit(setBlockedByTaskId)(v === NO_TASK ? null : v)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        <span className={blocker ? "" : "text-muted-foreground"}>
                          {blocker?.title ??
                            (blockedByTaskId ? "(task unavailable)" : "No linked task")}
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_TASK}>No linked task</SelectItem>
                      {blockerOptions.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            )}
          </div>
        </div>
      </DialogContent>

      {confirmingClose && (
        <ConfirmDialog
          title="Discard changes?"
          message="Your edits to this task haven't been saved."
          confirmLabel="Discard"
          confirmVariant="danger"
          onConfirm={onClose}
          onCancel={() => setConfirmingClose(false)}
        />
      )}
    </Dialog>
  )
}
