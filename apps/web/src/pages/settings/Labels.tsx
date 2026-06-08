import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Pencil, Plus, Trash2, X } from "lucide-react"
import { useState } from "react"
import { useOutletContext } from "react-router-dom"
import {
  Button,
  Card,
  CardHeader,
  IconButton,
  Input,
  LabelChip,
  Modal,
  Spinner,
} from "../../components/ui"
import { api, type Label } from "../../lib/api"
import { Feedback } from "./parts"

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
        className="h-8 w-9 shrink-0 cursor-pointer rounded border border-gray-300 bg-white p-0.5"
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
          <span className="text-xs font-medium text-gray-500">Name</span>
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
          <span className="text-xs font-medium text-gray-500">Color</span>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} />
          Primary
        </label>
        <div className="flex gap-2">
          <Button onClick={submit} disabled={save.isPending || !name.trim()}>
            <Check size={15} />
            {save.isPending ? "Saving…" : initial ? "Save" : "Create"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            <X size={15} />
            Cancel
          </Button>
        </div>
        <Feedback error={save.error} />
      </div>
    </Modal>
  )
}

export function Labels() {
  const { admin } = useOutletContext<{ admin: boolean }>()
  const qc = useQueryClient()
  const labels = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Label | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ["labels"] })

  if (labels.isPending) return <Spinner />
  if (labels.error) return <p className="text-sm text-red-600">{(labels.error as Error).message}</p>

  const all = [...(labels.data ?? [])].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          A shared vocabulary of labels — apply them to a concept (in Concepts) or to individual
          items{admin ? "" : "; managing the vocabulary is admin-only"}.
        </p>
        {admin && (
          <Button className="shrink-0 whitespace-nowrap" onClick={() => setCreating(true)}>
            <Plus size={15} />
            New label
          </Button>
        )}
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
        <CardHeader title={`Labels (${all.length})`} />
        {all.length === 0 ? (
          <p className="p-4 text-sm text-gray-400">No labels yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {all.map((l) => (
              <LabelRow
                key={l.id}
                label={l}
                admin={admin}
                onEdit={() => setEditing(l)}
                onChanged={invalidate}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/** One vocabulary row: chip + color, with edit (opens the modal) + delete (admin). */
function LabelRow({
  label,
  admin,
  onEdit,
  onChanged,
}: {
  label: Label
  admin: boolean
  onEdit: () => void
  onChanged: () => void
}) {
  const remove = useMutation({
    mutationFn: () => api.deleteLabel(label.id),
    onSuccess: onChanged,
  })

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <LabelChip color={label.color} primary={label.primary}>
        {label.name}
      </LabelChip>
      <span className="flex-1 truncate text-xs text-gray-400">{label.color ?? "no color"}</span>
      {admin && (
        <>
          <IconButton aria-label={`Edit ${label.name}`} onClick={onEdit}>
            <Pencil size={15} />
          </IconButton>
          <IconButton
            variant="danger"
            aria-label={`Delete ${label.name}`}
            disabled={remove.isPending}
            onClick={() => {
              if (confirm(`Delete label "${label.name}"? It will be removed from pickers.`))
                remove.mutate()
            }}
          >
            <Trash2 size={15} />
          </IconButton>
        </>
      )}
      {remove.error && (
        <span className="text-xs text-red-600">{(remove.error as Error).message}</span>
      )}
    </li>
  )
}
