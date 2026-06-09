import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Archive, ArchiveRestore, Check, Pencil, Plus, Trash2, X } from "lucide-react"
import { useState } from "react"
import { useOutletContext } from "react-router-dom"
import { Checkbox } from "@/components/ui/checkbox"
import { Label as FieldLabel } from "@/components/ui/label"
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  IconButton,
  Input,
  LabelChip,
  Modal,
  Spinner,
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

const DEFAULT_COLOR = "#6b7280" // gray-500

const HEX6 = /^#[0-9a-f]{6}$/i

/** Native swatch + hex text input, kept in sync. */
function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label="Label color"
        value={HEX6.test(value) ? value : DEFAULT_COLOR}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-9 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={DEFAULT_COLOR}
        className="w-28"
      />
    </div>
  )
}

/** Create or edit a label in a modal. `initial` present → edit, else create. */
function LabelModal({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Label
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name ?? "")
  const [color, setColor] = useState(initial?.color ?? DEFAULT_COLOR)
  const [primary, setPrimary] = useState(initial?.primary ?? false)

  const save = useMutation({
    mutationFn: () =>
      initial
        ? api.renameLabel(initial.id, { name: name.trim(), color: color.trim() || null, primary })
        : api.createLabel(name.trim(), color.trim() || null, primary),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })
  const submit = () => {
    if (name.trim()) save.mutate()
  }

  return (
    <Modal title={initial ? "Edit label" : "New label"} onClose={onClose}>
      <div className="space-y-3">
        <div className="space-y-1">
          <span className="block text-sm leading-none font-medium text-foreground">Name</span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit()
            }}
            placeholder="e.g. Urgent"
          />
        </div>
        <div className="space-y-1">
          <span className="block text-sm leading-none font-medium text-foreground">Color</span>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <FieldLabel className="flex items-center gap-1.5 text-sm font-normal text-foreground">
          <Checkbox checked={primary} onCheckedChange={(c) => setPrimary(c === true)} />
          Primary
        </FieldLabel>
        <div className="flex gap-2">
          <Button onClick={submit} disabled={save.isPending || !name.trim()}>
            <Check size={15} />
            {save.isPending ? "Saving…" : initial ? "Save" : "Create"}
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
  const [dialog, setDialog] = useState<LabelDialog>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ["labels"] })

  const archive = useMutation({
    mutationFn: (id: string) => api.archiveLabel(id),
    onSuccess: () => {
      setDialog(null)
      invalidate()
    },
  })
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreLabel(id),
    onSuccess: invalidate,
  })
  const del = useMutation({
    mutationFn: (id: string) => api.deleteLabel(id),
    onSuccess: () => {
      setDialog(null)
      invalidate()
    },
  })

  if (labels.isPending) return <Spinner />
  if (labels.error)
    return <p className="text-sm text-destructive">{(labels.error as Error).message}</p>

  const sorted = [...(labels.data ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const live = sorted.filter((l) => !l.archivedAt)
  const archived = sorted.filter((l) => l.archivedAt)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          A shared vocabulary of labels — apply them to a concept (in Concepts) or to individual
          items{admin ? "" : "; managing the vocabulary is admin-only"}.
        </p>
        <div className="flex items-center gap-3">
          {admin && archived.length > 0 && (
            <Button
              variant="link"
              onClick={() => setShowArchived((v) => !v)}
              className="h-auto whitespace-nowrap p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
            >
              {showArchived ? "Hide" : "Show"} archived ({archived.length})
            </Button>
          )}
          {admin && (
            <Button className="shrink-0 whitespace-nowrap" onClick={() => setCreating(true)}>
              <Plus size={15} />
              New label
            </Button>
          )}
        </div>
      </div>

      {creating && <LabelModal onClose={() => setCreating(false)} onSaved={invalidate} />}
      {editing && (
        <LabelModal
          key={editing.id}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      )}

      <Card>
        <CardHeader title={`Labels (${live.length})`} />
        {live.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No labels yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {live.map((l) => (
              <LabelRow
                key={l.id}
                label={l}
                admin={admin}
                onEdit={() => setEditing(l)}
                onArchive={() => setDialog({ kind: "archive", label: l })}
                onDelete={() => setDialog({ kind: "delete", label: l })}
              />
            ))}
          </ul>
        )}
      </Card>

      {showArchived && archived.length > 0 && (
        <Card>
          <CardHeader title={`Archived (${archived.length})`} />
          <ul className="divide-y divide-border">
            {archived.map((l) => (
              <LabelRow
                key={l.id}
                label={l}
                admin={admin}
                archived
                restorePending={restore.isPending}
                onRestore={() => restore.mutate(l.id)}
                onDelete={() => setDialog({ kind: "delete", label: l })}
              />
            ))}
          </ul>
        </Card>
      )}
      {restore.error && <p className="text-sm text-destructive">{labelMsg(restore.error)}</p>}

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

/** One vocabulary row. Live rows offer edit/archive/delete;
 *  archived rows offer restore/delete. */
function LabelRow({
  label,
  admin,
  archived = false,
  restorePending = false,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
}: {
  label: Label
  admin: boolean
  archived?: boolean
  restorePending?: boolean
  onEdit?: () => void
  onArchive?: () => void
  onRestore?: () => void
  onDelete?: () => void
}) {
  return (
    <li className={`flex items-center gap-3 px-6 py-3${archived ? " opacity-60" : ""}`}>
      <LabelChip color={label.color} primary={label.primary}>
        {label.name}
      </LabelChip>
      <span className="flex-1" />
      {admin &&
        (archived ? (
          <>
            <IconButton
              aria-label={`Restore ${label.name}`}
              disabled={restorePending}
              onClick={onRestore}
            >
              <ArchiveRestore size={15} />
            </IconButton>
            <IconButton variant="danger" aria-label={`Delete ${label.name}`} onClick={onDelete}>
              <Trash2 size={15} />
            </IconButton>
          </>
        ) : (
          <>
            <IconButton aria-label={`Edit ${label.name}`} onClick={onEdit}>
              <Pencil size={15} />
            </IconButton>
            <IconButton aria-label={`Archive ${label.name}`} onClick={onArchive}>
              <Archive size={15} />
            </IconButton>
            <IconButton variant="danger" aria-label={`Delete ${label.name}`} onClick={onDelete}>
              <Trash2 size={15} />
            </IconButton>
          </>
        ))}
    </li>
  )
}
