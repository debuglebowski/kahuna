import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Archive, ArchiveRestore, Check, Pencil, Plus, Trash2, X } from "lucide-react"
import type { ReactNode } from "react"
import { useState } from "react"
import { useOutletContext } from "react-router-dom"
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ColorSwatchPicker,
  ConfirmDialog,
  Drawer,
  IconButton,
  Input,
  LabelChip,
  Modal,
  randomPillColor,
  Spinner,
  ToggleChip,
  Toolbar,
} from "../../components/ui"
import { api, type Label } from "../../lib/api"
import { Feedback } from "./parts"

/** Map engine errors to a short message for the label dialogs. */
function labelMsg(e: unknown): string {
  const err = e as { code?: string; message?: string }
  if (err?.message?.includes("LabelNameConflict")) return "A label with that name already exists."
  if (err?.code === "FORBIDDEN" || err?.message?.includes("Admin only")) return "Admins only."
  return err?.message ?? "Something went wrong."
}

/** Shared name / color fields for the create modal and edit drawer. */
function LabelFields({
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
          placeholder="e.g. Urgent"
        />
      </div>
      <div className="space-y-1.5">
        <span className="block text-sm leading-none font-medium text-foreground">Color</span>
        <ColorSwatchPicker label="Label color" value={color || null} onChange={setColor} />
      </div>
    </div>
  )
}

/** Create a new label in a modal (editing happens in the drawer). */
function CreateLabelModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("")
  const [color, setColor] = useState(() => randomPillColor())

  const save = useMutation({
    mutationFn: () => api.createLabel(name.trim(), color.trim() || null),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })
  const submit = () => {
    if (name.trim()) save.mutate()
  }

  return (
    <Modal title="New label" onClose={onClose}>
      <div className="space-y-3">
        <LabelFields
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
        <Feedback error={save.error} />
      </div>
    </Modal>
  )
}

/** Edit a label in a drawer: the form, plus a Danger zone (archive/restore/delete). */
function LabelDrawer({
  label,
  admin,
  onClose,
  onSaved,
  onArchive,
  onRestore,
  onDelete,
  restorePending,
  restoreError,
}: {
  label: Label
  admin: boolean
  onClose: () => void
  onSaved: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
  restorePending: boolean
  restoreError?: ReactNode
}) {
  const [name, setName] = useState(label.name)
  // No color stays empty → the picker shows no selection and save keeps null.
  const [color, setColor] = useState(label.color ?? "")

  const save = useMutation({
    mutationFn: () => api.renameLabel(label.id, { name: name.trim(), color: color.trim() || null }),
    onSuccess: onSaved,
  })
  const submit = () => {
    if (name.trim()) save.mutate()
  }

  return (
    <Drawer
      title={
        <span className="flex items-center gap-2">
          <LabelChip color={label.color} primary={label.primary}>
            {label.name}
          </LabelChip>
        </span>
      }
      onClose={onClose}
    >
      <div className="space-y-5">
        <Card>
          <CardHeader
            title="Label"
            action={
              admin && (
                <Button onClick={submit} disabled={save.isPending || !name.trim()}>
                  <Check size={15} />
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              )
            }
          />
          <div className="space-y-3 p-4">
            <LabelFields
              name={name}
              setName={setName}
              color={color}
              setColor={setColor}
              onSubmit={submit}
              disabled={!admin}
            />
            <Feedback error={save.error} />
          </div>
        </Card>

        {admin && (
          <Card className="border-destructive/40">
            <CardHeader
              title={<span className="text-destructive">Danger zone</span>}
              action={label.archivedAt ? <Badge tone="amber">Archived</Badge> : undefined}
            />
            <div className="divide-y divide-border">
              {label.archivedAt ? (
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Restore this label</p>
                    <p className="text-xs text-muted-foreground">
                      Brings it back to pickers and chips.
                    </p>
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
                    <p className="text-sm font-medium text-foreground">Archive this label</p>
                    <p className="text-xs text-muted-foreground">
                      Hides it from pickers and chips; items keep it. Restore anytime.
                    </p>
                  </div>
                  <Button variant="outline" size="sm" className="shrink-0" onClick={onArchive}>
                    <Archive size={14} />
                    Archive
                  </Button>
                </div>
              )}
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Delete this label</p>
                  <p className="text-xs text-muted-foreground">
                    Permanently removes it from every concept and item that used it. This can't be
                    undone.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={onDelete}
                >
                  <Trash2 size={14} />
                  Delete
                </Button>
              </div>
            </div>
            {restoreError && <p className="px-4 pb-3 text-sm text-destructive">{restoreError}</p>}
          </Card>
        )}
      </div>
    </Drawer>
  )
}

/** Which destructive confirm dialog is open for a label (null = none). */
type LabelDialog = { kind: "archive" | "delete"; label: Label } | null

export function Labels() {
  const { admin } = useOutletContext<{ admin: boolean }>()
  const qc = useQueryClient()
  // Distinct key from the live ["labels"] vocabulary read elsewhere — the editor
  // needs archived too. Invalidating ["labels"] (prefix) refreshes both.
  const labels = useQuery({
    queryKey: ["labels", "withArchived"],
    queryFn: () => api.listLabels({ includeArchived: true }),
  })
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Label | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [filter, setFilter] = useState("")
  const [dialog, setDialog] = useState<LabelDialog>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ["labels"] })

  // Archive / delete close both the confirm dialog and the edit drawer; restore
  // closes the drawer too (all three "remove" the label from where you were).
  const archive = useMutation({
    mutationFn: (id: string) => api.archiveLabel(id),
    onSuccess: () => {
      setDialog(null)
      setEditing(null)
      invalidate()
    },
  })
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreLabel(id),
    onSuccess: () => {
      setEditing(null)
      invalidate()
    },
  })
  const del = useMutation({
    mutationFn: (id: string) => api.deleteLabel(id),
    onSuccess: () => {
      setDialog(null)
      setEditing(null)
      invalidate()
    },
  })

  if (labels.isPending) return <Spinner />
  if (labels.error)
    return <p className="text-sm text-destructive">{(labels.error as Error).message}</p>

  const sorted = [...(labels.data ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const archived = sorted.filter((l) => l.archivedAt)
  // Archived rows render inline (dimmed) when toggled on; the filter applies to both.
  const q = filter.trim().toLowerCase()
  const rows = sorted.filter(
    (l) => (showArchived || !l.archivedAt) && l.name.toLowerCase().includes(q),
  )

  return (
    <div className="space-y-3">
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter labels…">
        {admin && archived.length > 0 && (
          <ToggleChip pressed={showArchived} onPressedChange={setShowArchived}>
            Archived ({archived.length})
          </ToggleChip>
        )}
        {admin && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={15} />
            New label
          </Button>
        )}
      </Toolbar>

      {creating && <CreateLabelModal onClose={() => setCreating(false)} onSaved={invalidate} />}
      {editing && (
        <LabelDrawer
          key={editing.id}
          label={editing}
          admin={admin}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
          onArchive={() => setDialog({ kind: "archive", label: editing })}
          onRestore={() => restore.mutate(editing.id)}
          onDelete={() => setDialog({ kind: "delete", label: editing })}
          restorePending={restore.isPending}
          restoreError={restore.error ? labelMsg(restore.error) : undefined}
        />
      )}

      <Card>
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            {q
              ? `No labels match "${filter.trim()}".`
              : "No labels yet — a shared vocabulary you apply to concepts (in Concepts) or to individual items."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((l) => (
              <LabelRow key={l.id} label={l} onEdit={admin ? () => setEditing(l) : undefined} />
            ))}
          </ul>
        )}
      </Card>

      {dialog?.kind === "archive" && (
        <ConfirmDialog
          title="Archive label"
          message={
            <>
              Archive <strong>{dialog.label.name}</strong>? It drops out of pickers and chips, but
              items keep it — you can restore it anytime.
            </>
          }
          confirmLabel="Archive"
          pending={archive.isPending}
          error={archive.error ? labelMsg(archive.error) : undefined}
          onConfirm={() => archive.mutate(dialog.label.id)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Delete label"
          message={
            <>
              Permanently delete <strong>{dialog.label.name}</strong>? This can't be undone; it's
              removed from every concept and item that used it.
            </>
          }
          confirmLabel="Delete"
          confirmVariant="danger"
          secondaryLabel={dialog.label.archivedAt ? undefined : "Archive instead"}
          onSecondary={dialog.label.archivedAt ? undefined : () => archive.mutate(dialog.label.id)}
          pending={del.isPending || archive.isPending}
          error={del.error ? labelMsg(del.error) : undefined}
          onConfirm={() => del.mutate(dialog.label.id)}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  )
}

/** One vocabulary row — chip + color, with an edit pencil (opens the drawer) for admins.
 *  Archived rows render dimmed with a badge; archive/restore/delete live in the
 *  drawer's Danger zone, not on the row. */
function LabelRow({ label, onEdit }: { label: Label; onEdit?: () => void }) {
  return (
    <li className={`flex items-center gap-3 px-6 py-3${label.archivedAt ? " opacity-60" : ""}`}>
      <LabelChip color={label.color} primary={label.primary}>
        {label.name}
      </LabelChip>
      {label.archivedAt && <Badge tone="amber">archived</Badge>}
      <span className="flex-1" />
      {onEdit && (
        <IconButton aria-label={`Edit ${label.name}`} onClick={onEdit}>
          <Pencil size={15} />
        </IconButton>
      )}
    </li>
  )
}
