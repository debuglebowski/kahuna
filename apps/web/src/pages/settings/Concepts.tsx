import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Archive, ArchiveRestore, Check, Pencil, Plus, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useOutletContext } from "react-router-dom"
import { IconPicker } from "../../components/IconPicker"
import { LabelMultiSelect } from "../../components/LabelMultiSelect"
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Drawer,
  IconButton,
  Input,
  LabelChip,
  Modal,
  Spinner,
} from "../../components/ui"
import { api, type Field, type Label } from "../../lib/api"
import { ConceptIcon, DEFAULT_CONCEPT_ICON, DEFAULT_FIELD_ICON } from "../../lib/icons"
import { ConceptGraphCanvas } from "./ConceptGraphCanvas"
import { FieldForm, type FieldFormValue } from "./FieldForm"

/** Resolve label ids → chips for the non-admin (read-only) concept view. */
function ReadOnlyLabels({
  ids,
  vocab,
}: {
  ids: ReadonlyArray<string>
  vocab: ReadonlyArray<Label>
}) {
  const byId = new Map(vocab.map((l) => [l.id, l]))
  const resolved = ids
    .flatMap((id) => {
      const l = byId.get(id)
      return l ? [l] : []
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  if (resolved.length === 0) return <p className="text-xs text-gray-400">None.</p>
  return (
    <div className="flex flex-wrap gap-1.5">
      {resolved.map((l) => (
        <LabelChip key={l.id} color={l.color} primary={l.primary}>
          {l.name}
        </LabelChip>
      ))}
    </div>
  )
}

function msgOf(e: unknown): string {
  const err = e as { code?: string; message?: string }
  if (err?.code === "CONCEPT_IN_USE" || err?.message?.includes("ConceptInUse"))
    return "Can't delete: this concept still has items. Archive or delete them first."
  if (err?.code === "FIELD_IN_USE" || err?.message?.includes("FieldInUse"))
    return "Can't delete: this field is still used by relations. Archive it instead."
  if (err?.message?.includes("ConceptNameConflict"))
    return "A concept with that name already exists."
  if (err?.message?.includes("FieldNameConflict"))
    return "A field with that name already exists on this concept."
  if (err?.code === "FORBIDDEN" || err?.message?.includes("Admin only")) return "Admins only."
  return err?.message ?? "Something went wrong."
}

/** Render a field's config summary; `nameOf` resolves a relation target id → name. */
function summarize(f: Field, nameOf: (id: string) => string): string {
  switch (f.kind) {
    case "enum":
      return (f.config.options ?? []).join(", ")
    case "relation":
      return `→ ${f.config.target ? nameOf(f.config.target) : "?"} (${f.config.cardinality ?? "many"})`
    case "computed":
      return f.config.computedKind ?? ""
    case "user":
      return f.config.multiple ? "members (multiple)" : "member"
    case "money":
      return "amount + currency"
    case "json":
      return "json"
    case "text":
    case "number":
      return [f.config.format && `format: ${f.config.format}`, f.config.multiple && "multiple"]
        .filter(Boolean)
        .join(" · ")
    default:
      return f.config.multiple ? "multiple" : ""
  }
}

/** Which destructive confirm dialog is open (null = none). */
type Dialog =
  | { kind: "archiveConcept" }
  | { kind: "deleteConcept" }
  | { kind: "archiveField"; field: Field }
  | { kind: "deleteField"; field: Field }
  | null

export function Concepts() {
  const { admin } = useOutletContext<{ admin: boolean }>()
  const qc = useQueryClient()
  // Fetch archived too so the settings page can manage them; the live list (and
  // graph) are derived from this. The sidebar/graph elsewhere stay live-only.
  const concepts = useQuery({
    queryKey: ["concepts", "withArchived"],
    queryFn: () => api.listConcepts({ includeArchived: true }),
  })
  const liveConcepts = concepts.data?.filter((c) => !c.deletedAt) ?? []
  const archivedConcepts = concepts.data?.filter((c) => c.deletedAt) ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [pluralName, setPluralName] = useState("")
  const [icon, setIcon] = useState<string | null>(null)
  const [description, setDescription] = useState("")
  // Field add/edit happens in a modal; null = closed.
  const [fieldModal, setFieldModal] = useState<
    { mode: "add" } | { mode: "edit"; field: Field } | null
  >(null)
  const [creatingConcept, setCreatingConcept] = useState(false)
  const [newName, setNewName] = useState("")
  const [staticLabelIds, setStaticLabelIds] = useState<string[]>([])
  const [defaultLabelIds, setDefaultLabelIds] = useState<string[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [showArchivedFields, setShowArchivedFields] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)

  const selected = concepts.data?.find((c) => c.id === selectedId) ?? null
  const labelVocab = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })

  // Seed the editor whenever the selected concept changes.
  useEffect(() => {
    setName(selected?.name ?? "")
    setPluralName(selected?.pluralName ?? "")
    setIcon(selected?.icon ?? null)
    setDescription(selected?.description ?? "")
    setStaticLabelIds([...(selected?.staticLabelIds ?? [])])
    setDefaultLabelIds([...(selected?.defaultLabelIds ?? [])])
    setFieldModal(null)
  }, [selected])

  // Resolve a relation target concept id → its display name for field summaries.
  const conceptName = (id: string) => concepts.data?.find((c) => c.id === id)?.name ?? id

  // Distinct key from the live ["fields", id] used elsewhere (ConceptView): the
  // settings editor needs archived defs too, split client-side for display.
  const fields = useQuery({
    queryKey: ["fields", selectedId, "withArchived"],
    queryFn: () => api.listFields(selectedId!, { includeArchived: true }),
    enabled: !!selectedId,
  })
  const liveFields = fields.data?.filter((f) => !f.deletedAt) ?? []
  const archivedFields = fields.data?.filter((f) => f.deletedAt) ?? []

  const refetchFields = () => {
    qc.invalidateQueries({ queryKey: ["fields", selectedId, "withArchived"] })
    // Keep the live list other views read (ConceptView columns) fresh too.
    qc.invalidateQueries({ queryKey: ["fields", selectedId] })
  }
  // Concept names + relation fields drive the graph, so refresh it after every edit.
  const refetchGraph = () => qc.invalidateQueries({ queryKey: ["conceptGraph"] })

  const createConcept = useMutation({
    mutationFn: (name: string) => api.createConcept(name),
    onSuccess: (c) => {
      setCreatingConcept(false)
      setNewName("")
      qc.invalidateQueries({ queryKey: ["concepts"] })
      refetchGraph()
      setSelectedId(c.id)
    },
  })
  const submitNewConcept = () => {
    const trimmed = newName.trim()
    if (trimmed) createConcept.mutate(trimmed)
  }

  const saveConcept = useMutation({
    mutationFn: () =>
      api.updateConcept(selectedId!, {
        name: name.trim(),
        pluralName: pluralName.trim() || null,
        description: description.trim() || null,
        icon,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["concepts"] })
      refetchGraph()
    },
  })
  const refetchConcepts = () => qc.invalidateQueries({ queryKey: ["concepts"] })
  const archiveConcept = useMutation({
    mutationFn: (id: string) => api.archiveConcept(id),
    onSuccess: () => {
      setDialog(null)
      refetchConcepts()
      refetchGraph()
    },
  })
  const restoreConcept = useMutation({
    mutationFn: (id: string) => api.restoreConcept(id),
    onSuccess: () => {
      refetchConcepts()
      refetchGraph()
    },
  })
  const delConcept = useMutation({
    mutationFn: (id: string) => api.deleteConcept(id),
    onSuccess: () => {
      setDialog(null)
      setSelectedId(null)
      refetchConcepts()
      refetchGraph()
    },
  })
  const saveLabels = useMutation({
    // A static label is always applied, so it's never also a default.
    mutationFn: () =>
      api.updateConcept(selectedId!, {
        description: selected?.description ?? null,
        staticLabelIds,
        defaultLabelIds: defaultLabelIds.filter((id) => !staticLabelIds.includes(id)),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["concepts"] }),
  })
  const addField = useMutation({
    mutationFn: (v: FieldFormValue) =>
      api.addField({
        conceptId: selectedId!,
        name: v.name,
        kind: v.kind,
        config: v.config,
        icon: v.icon,
      }),
    onSuccess: () => {
      setFieldModal(null)
      refetchFields()
      refetchGraph()
    },
  })
  const updateField = useMutation({
    mutationFn: (vars: {
      id: string
      name: string
      config: FieldFormValue["config"]
      icon: string | null
    }) => api.updateField({ id: vars.id, name: vars.name, config: vars.config, icon: vars.icon }),
    onSuccess: () => {
      setFieldModal(null)
      refetchFields()
      refetchGraph()
    },
  })
  const archiveField = useMutation({
    mutationFn: (id: string) => api.archiveField(id),
    onSuccess: () => {
      setDialog(null)
      refetchFields()
      refetchGraph()
    },
  })
  const restoreField = useMutation({
    mutationFn: (id: string) => api.restoreField(id),
    onSuccess: () => {
      refetchFields()
      refetchGraph()
    },
  })
  const delField = useMutation({
    mutationFn: (id: string) => api.deleteField(id),
    onSuccess: () => {
      setDialog(null)
      refetchFields()
      refetchGraph()
    },
  })

  /** One field row — live rows offer edit/archive/delete; archived rows restore/delete. */
  const renderFieldRow = (f: Field, archived: boolean) => (
    <li key={f.id} className={`flex items-center gap-2 py-2.5${archived ? " opacity-60" : ""}`}>
      <span className="flex w-5 shrink-0 justify-center text-gray-500">
        <ConceptIcon value={f.icon || DEFAULT_FIELD_ICON} size={16} />
      </span>
      <span className="w-36 shrink-0 truncate text-sm font-medium text-gray-900">{f.name}</span>
      <Badge>{f.kind}</Badge>
      <span className="flex-1 truncate text-xs text-gray-500">{summarize(f, conceptName)}</span>
      {admin &&
        (archived ? (
          <>
            <IconButton
              aria-label={`Restore ${f.name}`}
              disabled={restoreField.isPending}
              onClick={() => restoreField.mutate(f.id)}
            >
              <ArchiveRestore size={15} />
            </IconButton>
            <IconButton
              variant="danger"
              aria-label={`Delete ${f.name}`}
              onClick={() => setDialog({ kind: "deleteField", field: f })}
            >
              <Trash2 size={15} />
            </IconButton>
          </>
        ) : (
          <>
            <IconButton
              aria-label={`Edit ${f.name}`}
              onClick={() => setFieldModal({ mode: "edit", field: f })}
            >
              <Pencil size={15} />
            </IconButton>
            <IconButton
              aria-label={`Archive ${f.name}`}
              onClick={() => setDialog({ kind: "archiveField", field: f })}
            >
              <Archive size={15} />
            </IconButton>
            <IconButton
              variant="danger"
              aria-label={`Delete ${f.name}`}
              onClick={() => setDialog({ kind: "deleteField", field: f })}
            >
              <Trash2 size={15} />
            </IconButton>
          </>
        ))}
    </li>
  )

  if (concepts.isPending) return <Spinner />

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Click a concept to view{admin ? " or edit" : ""} its settings.
        </p>
        <div className="flex items-center gap-3">
          {admin && archivedConcepts.length > 0 && (
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="text-xs text-gray-500 hover:text-gray-800"
            >
              {showArchived ? "Hide" : "Show"} archived ({archivedConcepts.length})
            </button>
          )}
          {admin && (
            <Button onClick={() => setCreatingConcept(true)}>
              <Plus size={15} />
              New concept
            </Button>
          )}
        </div>
      </div>

      <ConceptGraphCanvas selectedId={selectedId} onSelect={setSelectedId} />

      {showArchived && archivedConcepts.length > 0 && (
        <Card>
          <CardHeader title={`Archived concepts (${archivedConcepts.length})`} />
          <ul className="divide-y divide-gray-100">
            {archivedConcepts.map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-4 py-2.5">
                <span className="flex w-5 shrink-0 justify-center text-gray-500">
                  <ConceptIcon value={c.icon || DEFAULT_CONCEPT_ICON} size={16} />
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className="flex-1 truncate text-left text-sm font-medium text-gray-700 hover:text-gray-900"
                >
                  {c.name}
                </button>
                {admin && (
                  <>
                    <IconButton
                      aria-label={`Restore ${c.name}`}
                      disabled={restoreConcept.isPending}
                      onClick={() => restoreConcept.mutate(c.id)}
                    >
                      <ArchiveRestore size={15} />
                    </IconButton>
                    <IconButton
                      variant="danger"
                      aria-label={`Delete ${c.name}`}
                      onClick={() => {
                        setSelectedId(c.id)
                        setDialog({ kind: "deleteConcept" })
                      }}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {creatingConcept && (
        <Modal title="New concept" onClose={() => setCreatingConcept(false)}>
          <div className="space-y-3">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewConcept()
              }}
              placeholder="Concept name…"
            />
            <div className="flex gap-2">
              <Button
                onClick={submitNewConcept}
                disabled={createConcept.isPending || !newName.trim()}
              >
                <Plus size={15} />
                {createConcept.isPending ? "Creating…" : "Create"}
              </Button>
              <Button variant="outline" onClick={() => setCreatingConcept(false)}>
                <X size={15} />
                Cancel
              </Button>
            </div>
            {createConcept.error && (
              <p className="text-xs text-red-600">{msgOf(createConcept.error)}</p>
            )}
          </div>
        </Modal>
      )}

      {selected && (
        <Drawer
          title={
            <span className="flex items-center gap-2">
              <ConceptIcon value={selected.icon || DEFAULT_CONCEPT_ICON} size={16} />
              {selected.name}
            </span>
          }
          onClose={() => setSelectedId(null)}
          headerAction={
            <Link
              to={`/concepts/${selected.id}`}
              className="text-xs text-gray-500 hover:text-gray-800"
            >
              View instances
            </Link>
          }
        >
          <div className="space-y-5">
            <Card>
              <CardHeader
                title="Concept"
                action={
                  admin && (
                    <Button
                      onClick={() => saveConcept.mutate()}
                      disabled={saveConcept.isPending || !name.trim()}
                    >
                      <Check size={15} />
                      {saveConcept.isPending ? "Saving…" : "Save"}
                    </Button>
                  )
                }
              />
              <div className="space-y-2 p-4">
                <span className="text-xs font-medium text-gray-500">Name</span>
                <div className="flex items-center gap-2">
                  <IconPicker value={icon} onChange={setIcon} disabled={!admin} />
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!admin}
                    className="flex-1"
                  />
                </div>
                <span className="text-xs font-medium text-gray-500">Plural name</span>
                <Input
                  value={pluralName}
                  onChange={(e) => setPluralName(e.target.value)}
                  disabled={!admin}
                  placeholder={name ? `${name}s` : "Plural name…"}
                />
                <p className="text-xs text-gray-400">
                  Shown in the sidebar; falls back to the singular name when blank.
                </p>
                <span className="text-xs font-medium text-gray-500">Description</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  disabled={!admin}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm outline-none focus:border-gray-500 disabled:bg-gray-50 disabled:text-gray-500"
                />
                {saveConcept.error && (
                  <p className="text-sm text-red-600">{msgOf(saveConcept.error)}</p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Labels"
                action={
                  admin && (
                    <Button onClick={() => saveLabels.mutate()} disabled={saveLabels.isPending}>
                      <Check size={15} />
                      {saveLabels.isPending ? "Saving…" : "Save"}
                    </Button>
                  )
                }
              />
              <div className="space-y-4 p-4">
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-gray-500">Always applied (static)</span>
                  <p className="text-xs text-gray-400">
                    Inherited by every item of this concept; can't be removed per item.
                  </p>
                  {admin ? (
                    <LabelMultiSelect
                      all={labelVocab.data ?? []}
                      selectedIds={staticLabelIds}
                      onChange={setStaticLabelIds}
                    />
                  ) : (
                    <ReadOnlyLabels ids={selected.staticLabelIds} vocab={labelVocab.data ?? []} />
                  )}
                </div>
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-gray-500">Default on new items</span>
                  <p className="text-xs text-gray-400">
                    Pre-applied when an item is created; editable per item afterward.
                  </p>
                  {admin ? (
                    <LabelMultiSelect
                      all={labelVocab.data ?? []}
                      selectedIds={defaultLabelIds}
                      onChange={setDefaultLabelIds}
                      excludeIds={staticLabelIds}
                    />
                  ) : (
                    <ReadOnlyLabels ids={selected.defaultLabelIds} vocab={labelVocab.data ?? []} />
                  )}
                </div>
                {admin && (labelVocab.data?.length ?? 0) === 0 && (
                  <p className="text-xs text-gray-400">
                    No labels yet — create some in{" "}
                    <Link to="/settings/labels" className="underline">
                      Labels
                    </Link>
                    .
                  </p>
                )}
                {saveLabels.error && (
                  <p className="text-sm text-red-600">{msgOf(saveLabels.error)}</p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Fields"
                action={
                  admin && (
                    <div className="flex items-center gap-2">
                      {archivedFields.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowArchivedFields((v) => !v)}
                          className="text-xs text-gray-500 hover:text-gray-800"
                        >
                          {showArchivedFields ? "Hide" : "Show"} archived ({archivedFields.length})
                        </button>
                      )}
                      <Button variant="outline" onClick={() => setFieldModal({ mode: "add" })}>
                        <Plus size={15} />
                        Add field
                      </Button>
                    </div>
                  )
                }
              />
              <div className="space-y-3 p-4">
                {fields.isPending && <Spinner />}
                {!fields.isPending && liveFields.length === 0 && (
                  <p className="text-xs text-gray-400">No fields yet.</p>
                )}
                <ul className="divide-y divide-gray-100">
                  {liveFields.map((f) => renderFieldRow(f, false))}
                </ul>
                {showArchivedFields && archivedFields.length > 0 && (
                  <div className="space-y-1 border-t border-gray-100 pt-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                      Archived
                    </p>
                    <ul className="divide-y divide-gray-100">
                      {archivedFields.map((f) => renderFieldRow(f, true))}
                    </ul>
                  </div>
                )}
                {(archiveField.error || restoreField.error || delField.error) && (
                  <p className="text-sm text-red-600">
                    {msgOf(archiveField.error ?? restoreField.error ?? delField.error)}
                  </p>
                )}
              </div>
            </Card>

            {admin && (
              <div className="space-y-2 border-t border-gray-100 pt-4">
                {selected.deletedAt ? (
                  <div className="flex flex-wrap items-center gap-4">
                    <Badge tone="amber">Archived</Badge>
                    <button
                      type="button"
                      disabled={restoreConcept.isPending}
                      onClick={() => restoreConcept.mutate(selected.id)}
                      className="inline-flex items-center gap-1.5 text-xs text-gray-500 transition hover:text-gray-800 disabled:opacity-50"
                    >
                      <ArchiveRestore size={14} />
                      {restoreConcept.isPending ? "Restoring…" : "Restore concept"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDialog({ kind: "deleteConcept" })}
                      className="inline-flex items-center gap-1.5 text-xs text-gray-400 transition hover:text-red-600"
                    >
                      <Trash2 size={14} />
                      Delete permanently
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-4">
                    <button
                      type="button"
                      onClick={() => setDialog({ kind: "archiveConcept" })}
                      className="inline-flex items-center gap-1.5 text-xs text-gray-400 transition hover:text-gray-800"
                    >
                      <Archive size={14} />
                      Archive concept
                    </button>
                    <button
                      type="button"
                      onClick={() => setDialog({ kind: "deleteConcept" })}
                      className="inline-flex items-center gap-1.5 text-xs text-gray-400 transition hover:text-red-600"
                    >
                      <Trash2 size={14} />
                      Delete concept
                    </button>
                  </div>
                )}
                {(restoreConcept.error || archiveConcept.error || delConcept.error) && (
                  <p className="text-sm text-red-600">
                    {msgOf(restoreConcept.error ?? archiveConcept.error ?? delConcept.error)}
                  </p>
                )}
              </div>
            )}
          </div>
        </Drawer>
      )}

      {fieldModal && (
        <Modal
          title={fieldModal.mode === "add" ? "Add field" : `Edit field — ${fieldModal.field.name}`}
          onClose={() => setFieldModal(null)}
        >
          <FieldForm
            concepts={liveConcepts}
            initial={fieldModal.mode === "edit" ? fieldModal.field : undefined}
            onSubmit={(v) =>
              fieldModal.mode === "add"
                ? addField.mutate(v)
                : updateField.mutate({
                    id: fieldModal.field.id,
                    name: v.name,
                    config: v.config,
                    icon: v.icon,
                  })
            }
            onCancel={() => setFieldModal(null)}
            pending={fieldModal.mode === "add" ? addField.isPending : updateField.isPending}
          />
          {(addField.error || updateField.error) && (
            <p className="mt-3 text-sm text-red-600">
              {msgOf(addField.error ?? updateField.error)}
            </p>
          )}
        </Modal>
      )}

      {dialog?.kind === "archiveConcept" && selected && (
        <ConfirmDialog
          title="Archive concept"
          message={
            <>
              Archive <strong>{selected.name}</strong>? It's hidden from the sidebar and lists, but
              its items and fields are kept — you can restore it anytime.
            </>
          }
          confirmLabel="Archive"
          pending={archiveConcept.isPending}
          error={archiveConcept.error ? msgOf(archiveConcept.error) : undefined}
          onConfirm={() => archiveConcept.mutate(selected.id)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "deleteConcept" && selected && (
        <ConfirmDialog
          title="Delete concept"
          message={
            <>
              Permanently delete <strong>{selected.name}</strong> and its fields? This can't be
              undone, and is refused while it still has items.
            </>
          }
          confirmLabel="Delete"
          confirmVariant="danger"
          secondaryLabel={selected.deletedAt ? undefined : "Archive instead"}
          onSecondary={selected.deletedAt ? undefined : () => archiveConcept.mutate(selected.id)}
          pending={delConcept.isPending || archiveConcept.isPending}
          error={delConcept.error ? msgOf(delConcept.error) : undefined}
          onConfirm={() => delConcept.mutate(selected.id)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "archiveField" && (
        <ConfirmDialog
          title="Archive field"
          message={
            <>
              Archive <strong>{dialog.field.name}</strong>? It drops off forms and the table, but
              existing values are kept — you can restore it anytime.
            </>
          }
          confirmLabel="Archive"
          pending={archiveField.isPending}
          error={archiveField.error ? msgOf(archiveField.error) : undefined}
          onConfirm={() => archiveField.mutate(dialog.field.id)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "deleteField" && (
        <ConfirmDialog
          title="Delete field"
          message={
            <>
              Permanently delete <strong>{dialog.field.name}</strong>? This can't be undone, and is
              refused while relations still reference it.
            </>
          }
          confirmLabel="Delete"
          confirmVariant="danger"
          secondaryLabel={dialog.field.deletedAt ? undefined : "Archive instead"}
          onSecondary={
            dialog.field.deletedAt ? undefined : () => archiveField.mutate(dialog.field.id)
          }
          pending={delField.isPending || archiveField.isPending}
          error={delField.error ? msgOf(delField.error) : undefined}
          onConfirm={() => delField.mutate(dialog.field.id)}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  )
}
