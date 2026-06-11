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
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useOutletContext, useSearchParams } from "react-router-dom"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { IconPicker } from "../../components/IconPicker"
import { LabelMultiSelect } from "../../components/LabelMultiSelect"
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
  PILL_COLORS,
  randomPillColor,
  Spinner,
  ToggleChip,
  Toolbar,
} from "../../components/ui"
import { api, type Field, type Instance, type Label } from "../../lib/api"
import { ConceptIcon, DEFAULT_CONCEPT_ICON, DEFAULT_FIELD_ICON } from "../../lib/icons"
import { showValue } from "../../lib/utils"
import { ConceptGraphCanvas } from "./ConceptGraphCanvas"
import { FieldForm, type FieldFormValue, fieldKindLabel } from "./FieldForm"

/** Display name for a palette hex; a legacy out-of-palette hex shows verbatim. */
const colorNameOf = (hex: string): string =>
  PILL_COLORS.find((c) => c.hex === hex.toLowerCase())?.name ?? hex

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
  if (resolved.length === 0) return <p className="text-xs text-muted-foreground">None.</p>
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
  const base = (() => {
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
  })()
  return [base, f.config.unique && "unique"].filter(Boolean).join(" · ")
}

/** A live field row wrapped for drag-reorder: grip handle + the shared row body. */
function SortableFieldRow({ field, children }: { field: Field; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
  })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 py-2.5${isDragging ? " opacity-60" : ""}`}
    >
      <button
        type="button"
        className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
        aria-label={`Drag ${field.name} to reorder`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      {children}
    </li>
  )
}

/** Which destructive confirm dialog is open (null = none). */
type Dialog =
  | { kind: "archiveConcept" }
  | { kind: "deleteConcept" }
  | { kind: "archiveField"; field: Field }
  | { kind: "deleteField"; field: Field }
  | { kind: "deleteItem"; inst: Instance }
  | null

export function Concepts() {
  const { admin } = useOutletContext<{ admin: boolean }>()
  const qc = useQueryClient()
  // Fetch archived too so the settings page can manage them; the live list (and
  // graph) are derived from this. The sidebar/graph elsewhere stay live-only.
  const concepts = useQuery({
    queryKey: ["concepts", "withArchived"],
    queryFn: () => api.listConcepts({ includeArchived: true, withCounts: true }),
  })
  const liveConcepts = concepts.data?.filter((c) => !c.archivedAt) ?? []
  const archivedConcepts = concepts.data?.filter((c) => c.archivedAt) ?? []
  // Deep link (?concept=<id>) — e.g. the item view's "Edit concept" action.
  const [searchParams] = useSearchParams()
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("concept"))
  const [name, setName] = useState("")
  const [pluralName, setPluralName] = useState("")
  const [icon, setIcon] = useState<string | null>(null)
  const [color, setColor] = useState<string | null>(null)
  const [colorOpen, setColorOpen] = useState(false)
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
  const [filter, setFilter] = useState("")
  const [dialog, setDialog] = useState<Dialog>(null)

  const selected = concepts.data?.find((c) => c.id === selectedId) ?? null
  const labelVocab = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })

  // Colors claimed by OTHER live concepts — the picker disables them so every
  // concept keeps a unique color.
  const takenColors = new Set(
    (concepts.data ?? []).flatMap((c) =>
      c.id !== selectedId && !c.archivedAt && c.color ? [c.color.toLowerCase()] : [],
    ),
  )

  // Seed the editor whenever the selected concept changes.
  useEffect(() => {
    setName(selected?.name ?? "")
    setPluralName(selected?.pluralName ?? "")
    setIcon(selected?.icon ?? null)
    setColor(selected?.color ?? null)
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
  const liveFields = fields.data?.filter((f) => !f.archivedAt) ?? []
  const archivedFields = fields.data?.filter((f) => f.archivedAt) ?? []

  const refetchFields = () => {
    qc.invalidateQueries({ queryKey: ["fields", selectedId, "withArchived"] })
    // Keep the live list other views read (ConceptView columns) fresh too.
    qc.invalidateQueries({ queryKey: ["fields", selectedId] })
  }
  // Concept names + relation fields drive the graph, so refresh it after every edit.
  const refetchGraph = () => qc.invalidateQueries({ queryKey: ["conceptGraph"] })

  const createConcept = useMutation({
    // New concepts start with a default color: a palette hex no live concept
    // already uses (random reuse only once all 40 are claimed).
    mutationFn: (name: string) =>
      api.createConcept(
        name,
        randomPillColor(
          (concepts.data ?? []).flatMap((c) => (c.archivedAt || !c.color ? [] : [c.color])),
        ),
      ),
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
        color,
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
  const toggleVersioning = useMutation({
    mutationFn: (enabled: boolean) =>
      api.updateConcept(selectedId!, {
        description: selected?.description ?? null,
        versioningEnabled: enabled,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["concepts"] }),
  })
  // Archived items: restore, or purge (admin) — the data-hygiene side of a
  // concept, so it lives here with the rest of its configuration.
  const archivedItems = useQuery({
    queryKey: ["instances", selectedId, "archived"],
    queryFn: () => api.listInstances(selectedId!, { includeArchived: true }),
    enabled: !!selectedId,
    select: (rows) => rows.filter((i) => i.archivedAt),
  })
  const refetchArchived = () =>
    qc.invalidateQueries({ queryKey: ["instances", selectedId, "archived"] })
  const restoreItem = useMutation({
    mutationFn: (i: Instance) => api.restoreInstance(i.id, i.version),
    onSuccess: refetchArchived,
  })
  const delItem = useMutation({
    mutationFn: (i: Instance) => api.deleteInstance(i.id),
    onSuccess: () => {
      setDialog(null)
      refetchArchived()
    },
  })
  // A human-ish label for an item row: its first non-empty scalar value.
  const itemLabel = (state: Record<string, unknown>) => {
    for (const f of liveFields) {
      if (f.kind === "relation" || f.kind === "file") continue
      const v = state[f.id]
      if (v !== undefined && v !== null && v !== "") return showValue(v)
    }
    return "this item"
  }
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
  const reorderFieldsMut = useMutation({
    mutationFn: (orders: { id: string; position: number }[]) =>
      api.reorderFields(selectedId!, orders),
    onSuccess: refetchFields,
  })
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onFieldDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = liveFields.findIndex((f) => f.id === active.id)
    const to = liveFields.findIndex((f) => f.id === over.id)
    if (from < 0 || to < 0) return
    const next = arrayMove(liveFields, from, to)
    // Reflect the new order immediately so the row doesn't snap back before the
    // refetch lands (live list reads server array order, not `position`).
    qc.setQueryData<Field[]>(["fields", selectedId, "withArchived"], (old) => {
      if (!old) return old
      const rank = new Map(next.map((f, i) => [f.id, i]))
      return [...old].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
    })
    reorderFieldsMut.mutate(next.map((f, i) => ({ id: f.id, position: i })))
  }

  /** Shared body of a field row — live rows offer edit/archive/delete; archived rows
   *  restore/delete. Wrapped in a plain <li> (archived/read-only) or a drag-sortable
   *  <li> (admin, live) by the caller. */
  const fieldRowBody = (f: Field, archived: boolean) => (
    <>
      <span className="flex w-5 shrink-0 justify-center text-muted-foreground">
        <ConceptIcon value={f.icon || DEFAULT_FIELD_ICON} size={16} />
      </span>
      <span className="w-36 shrink-0 truncate text-sm font-medium text-foreground">{f.name}</span>
      <Badge>{fieldKindLabel(f.kind)}</Badge>
      <span className="flex-1 truncate text-xs text-muted-foreground">
        {summarize(f, conceptName)}
      </span>
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
    </>
  )

  /** A non-sortable field row (archived rows, or live rows for non-admins). */
  const renderFieldRow = (f: Field, archived: boolean) => (
    <li key={f.id} className={`flex items-center gap-2 py-2.5${archived ? " opacity-60" : ""}`}>
      {fieldRowBody(f, archived)}
    </li>
  )

  if (concepts.isPending) return <Spinner />

  // The find-filter narrows the archived list too (the canvas dims live ones).
  const q = filter.trim().toLowerCase()
  const archivedShown = archivedConcepts.filter((c) => c.name.toLowerCase().includes(q))

  return (
    <div className="space-y-3">
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Find concept…">
        {admin && archivedConcepts.length > 0 && (
          <ToggleChip pressed={showArchived} onPressedChange={setShowArchived}>
            Archived ({archivedConcepts.length})
          </ToggleChip>
        )}
        {admin && (
          <Button size="sm" onClick={() => setCreatingConcept(true)}>
            <Plus size={15} />
            New concept
          </Button>
        )}
      </Toolbar>

      <ConceptGraphCanvas selectedId={selectedId} onSelect={setSelectedId} filter={filter} />

      {showArchived && archivedShown.length > 0 && (
        <Card>
          <CardHeader title={`Archived concepts (${archivedShown.length})`} />
          <ul className="divide-y divide-border">
            {archivedShown.map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-6 py-2.5">
                <span className="flex w-5 shrink-0 justify-center text-muted-foreground">
                  <ConceptIcon value={c.icon || DEFAULT_CONCEPT_ICON} size={16} />
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className="truncate text-left text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  {c.name}
                </button>
                <span className="flex-1 text-xs text-muted-foreground">
                  {c.itemCount ? `${c.itemCount} item${c.itemCount === 1 ? "" : "s"}` : "empty"}
                </span>
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
              <p className="text-xs text-destructive">{msgOf(createConcept.error)}</p>
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
              <div className="space-y-2 p-6">
                <span className="block text-sm leading-none font-medium text-foreground">Name</span>
                <div className="flex items-center gap-2">
                  <IconPicker value={icon} onChange={setIcon} disabled={!admin} />
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!admin}
                    className="flex-1"
                  />
                </div>
                <span className="block text-sm leading-none font-medium text-foreground">
                  Plural name
                </span>
                <Input
                  value={pluralName}
                  onChange={(e) => setPluralName(e.target.value)}
                  disabled={!admin}
                  placeholder={name ? `${name}s` : "Plural name…"}
                />
                <p className="text-xs text-muted-foreground">
                  Shown in the sidebar; falls back to the singular name when blank.
                </p>
                <span className="block pt-1 text-sm leading-none font-medium text-foreground">
                  Color
                </span>
                <Popover open={colorOpen} onOpenChange={setColorOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" disabled={!admin}>
                      {color ? (
                        <LabelChip color={color}>{colorNameOf(color)}</LabelChip>
                      ) : (
                        <span className="text-muted-foreground">No color</span>
                      )}
                      <ChevronDown className="text-muted-foreground" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-auto max-w-80 space-y-3">
                    <ColorSwatchPicker
                      label="Concept color"
                      preview={name.trim() || "Concept"}
                      value={color}
                      taken={takenColors}
                      onChange={(hex) => {
                        setColor(hex)
                        setColorOpen(false)
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setColor(null)
                        setColorOpen(false)
                      }}
                    >
                      No color
                    </Button>
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-muted-foreground">
                  Tints this concept's items in the relationship graph; none renders neutral.
                </p>
                <span className="block text-sm leading-none font-medium text-foreground">
                  Description
                </span>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  disabled={!admin}
                />
                {saveConcept.error && (
                  <p className="text-sm text-destructive">{msgOf(saveConcept.error)}</p>
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
              <div className="space-y-4 p-6">
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Always applied (static)
                  </span>
                  <p className="text-xs text-muted-foreground">
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
                  <span className="text-xs font-medium text-muted-foreground">
                    Default on new items
                  </span>
                  <p className="text-xs text-muted-foreground">
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
                  <p className="text-xs text-muted-foreground">
                    No labels yet — create some in{" "}
                    <Link to="/settings/labels" className="underline">
                      Labels
                    </Link>
                    .
                  </p>
                )}
                {saveLabels.error && (
                  <p className="text-sm text-destructive">{msgOf(saveLabels.error)}</p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Versioning" />
              <div className="space-y-3 p-6">
                <label htmlFor="versioning-toggle" className="flex items-start gap-3">
                  <Checkbox
                    id="versioning-toggle"
                    checked={selected.versioningEnabled}
                    disabled={!admin || toggleVersioning.isPending}
                    onCheckedChange={(v) => toggleVersioning.mutate(v === true)}
                    className="mt-0.5"
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium text-foreground">
                      Enable versioning
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Items hold multiple draft → published versions. New items start as a draft and
                      aren't shown or referenceable until published; lists show only the latest
                      published version. Other items can reference "Latest" or pin a specific
                      version.
                    </span>
                  </span>
                </label>
                {toggleVersioning.error && (
                  <p className="text-sm text-destructive">
                    {msgOf(toggleVersioning.error)}
                    {String(toggleVersioning.error).includes("VERSIONING_IN_USE") ||
                    msgOf(toggleVersioning.error).includes("VersioningInUse")
                      ? " — disable is blocked while items have multiple versions or an open draft."
                      : ""}
                  </p>
                )}
              </div>
            </Card>

            {(archivedItems.data?.length ?? 0) > 0 && (
              <Card>
                <CardHeader title={`Archived items (${archivedItems.data!.length})`} />
                <ul className="divide-y divide-border">
                  {archivedItems.data!.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 px-6 py-2 opacity-80">
                      <span className="flex-1 truncate text-sm text-foreground">
                        {itemLabel(r.state)}
                      </span>
                      <IconButton
                        aria-label={`Restore ${itemLabel(r.state)}`}
                        disabled={restoreItem.isPending}
                        onClick={() => restoreItem.mutate(r)}
                      >
                        <ArchiveRestore size={15} />
                      </IconButton>
                      {admin && (
                        <IconButton
                          variant="danger"
                          aria-label={`Delete ${itemLabel(r.state)}`}
                          onClick={() => setDialog({ kind: "deleteItem", inst: r })}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      )}
                    </li>
                  ))}
                </ul>
                {restoreItem.error && (
                  <p className="px-6 pb-4 text-sm text-destructive">{msgOf(restoreItem.error)}</p>
                )}
              </Card>
            )}

            <Card>
              <CardHeader
                title="Fields"
                action={
                  admin && (
                    <div className="flex items-center gap-2">
                      {archivedFields.length > 0 && (
                        <Button
                          variant="link"
                          onClick={() => setShowArchivedFields((v) => !v)}
                          className="h-auto p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
                        >
                          {showArchivedFields ? "Hide" : "Show"} archived ({archivedFields.length})
                        </Button>
                      )}
                      <Button variant="outline" onClick={() => setFieldModal({ mode: "add" })}>
                        <Plus size={15} />
                        Add field
                      </Button>
                    </div>
                  )
                }
              />
              <div className="space-y-3 p-6">
                {fields.isPending && <Spinner />}
                {!fields.isPending && liveFields.length === 0 && (
                  <p className="text-xs text-muted-foreground">No fields yet.</p>
                )}
                {liveFields.length > 0 &&
                  (admin ? (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={onFieldDragEnd}
                    >
                      <SortableContext
                        items={liveFields.map((f) => f.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <ul className="divide-y divide-border">
                          {liveFields.map((f) => (
                            <SortableFieldRow key={f.id} field={f}>
                              {fieldRowBody(f, false)}
                            </SortableFieldRow>
                          ))}
                        </ul>
                      </SortableContext>
                    </DndContext>
                  ) : (
                    <ul className="divide-y divide-border">
                      {liveFields.map((f) => renderFieldRow(f, false))}
                    </ul>
                  ))}
                {showArchivedFields && archivedFields.length > 0 && (
                  <div className="space-y-1 border-t border-border pt-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Archived
                    </p>
                    <ul className="divide-y divide-border">
                      {archivedFields.map((f) => renderFieldRow(f, true))}
                    </ul>
                  </div>
                )}
                {(archiveField.error || restoreField.error || delField.error) && (
                  <p className="text-sm text-destructive">
                    {msgOf(archiveField.error ?? restoreField.error ?? delField.error)}
                  </p>
                )}
              </div>
            </Card>

            {admin && (
              <Card className="border-destructive/40">
                <CardHeader
                  title={<span className="text-destructive">Danger zone</span>}
                  action={selected.archivedAt ? <Badge tone="amber">Archived</Badge> : undefined}
                />
                <div className="divide-y divide-border">
                  {selected.archivedAt ? (
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">Restore this concept</p>
                        <p className="text-xs text-muted-foreground">
                          Brings it back to the sidebar, lists, and graph.
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={restoreConcept.isPending}
                        onClick={() => restoreConcept.mutate(selected.id)}
                      >
                        <ArchiveRestore size={14} />
                        {restoreConcept.isPending ? "Restoring…" : "Restore"}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">Archive this concept</p>
                        <p className="text-xs text-muted-foreground">
                          Hides it from the sidebar and lists; its fields
                          {selected.itemCount
                            ? ` and ${selected.itemCount} item${selected.itemCount === 1 ? "" : "s"}`
                            : ""}{" "}
                          are kept. Restore anytime.
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => setDialog({ kind: "archiveConcept" })}
                      >
                        <Archive size={14} />
                        Archive
                      </Button>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">Delete this concept</p>
                      <p className="text-xs text-muted-foreground">
                        Permanently removes it and its fields. This can't be undone.
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setDialog({ kind: "deleteConcept" })}
                    >
                      <Trash2 size={14} />
                      Delete
                    </Button>
                  </div>
                </div>
                {(restoreConcept.error || archiveConcept.error || delConcept.error) && (
                  <p className="px-4 pb-3 text-sm text-destructive">
                    {msgOf(restoreConcept.error ?? archiveConcept.error ?? delConcept.error)}
                  </p>
                )}
              </Card>
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
            <p className="mt-3 text-sm text-destructive">
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
              its fields
              {selected.itemCount
                ? ` and ${selected.itemCount} item${selected.itemCount === 1 ? "" : "s"}`
                : ""}{" "}
              are kept — you can restore it anytime.
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
            selected.itemCount ? (
              <>
                <strong>{selected.name}</strong> still has {selected.itemCount} item
                {selected.itemCount === 1 ? "" : "s"}, so it can't be deleted. Archive it (its items
                come back on restore), or delete its items first.
              </>
            ) : (
              <>
                Permanently delete <strong>{selected.name}</strong> and its fields? This can't be
                undone.
              </>
            )
          }
          confirmLabel="Delete"
          confirmVariant="danger"
          secondaryLabel={selected.archivedAt ? undefined : "Archive instead"}
          onSecondary={selected.archivedAt ? undefined : () => archiveConcept.mutate(selected.id)}
          pending={delConcept.isPending || archiveConcept.isPending}
          error={delConcept.error ? msgOf(delConcept.error) : undefined}
          onConfirm={() => delConcept.mutate(selected.id)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "deleteItem" && (
        <ConfirmDialog
          title="Delete item"
          message={
            <>
              Permanently delete <strong>{itemLabel(dialog.inst.state)}</strong>? This can't be
              undone, and is refused while other items still link to it.
            </>
          }
          confirmLabel="Delete"
          confirmVariant="danger"
          pending={delItem.isPending}
          error={delItem.error ? msgOf(delItem.error) : undefined}
          onConfirm={() => delItem.mutate(dialog.inst)}
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
          secondaryLabel={dialog.field.archivedAt ? undefined : "Archive instead"}
          onSecondary={
            dialog.field.archivedAt ? undefined : () => archiveField.mutate(dialog.field.id)
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
