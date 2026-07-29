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
  ChevronDown,
  Columns3,
  GripVertical,
  LayoutDashboard,
  Lock,
  Pencil,
  Plus,
  SlidersHorizontal,
  Star,
  Trash2,
} from "lucide-react"
import { useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { IconPicker } from "../../components/IconPicker"
import { LabelMultiSelect } from "../../components/LabelMultiSelect"
import { usePageChrome } from "../../components/Layout"
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ColorSwatchPicker,
  ConfirmDialog,
  IconButton,
  InfoHint,
  Input,
  LabelChip,
  Modal,
  PILL_COLORS,
  Spinner,
  TabBar,
  TabBarItem,
} from "../../components/ui"
import {
  api,
  type Concept,
  type Dashboard,
  type EditReach,
  type Field,
  type Instance,
  type Label,
} from "../../lib/api"
import { ConceptIcon, DEFAULT_CONCEPT_ICON, DEFAULT_FIELD_ICON } from "../../lib/icons"
import { useUnsavedGuard } from "../../lib/useUnsavedGuard"
import { showValue } from "../../lib/utils"
import { FieldForm, type FieldFormValue, fieldKindLabel } from "./FieldForm"

/** Map engine errors to a short message for the concept dialogs. */
export function msgOf(e: unknown): string {
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

/** A concept's record-view row — drag to reorder (top = opens by default), click
 *  to edit, trash to delete. */
function RecordViewRow({
  view,
  isFirst,
  onOpen,
  onDelete,
}: {
  view: Dashboard
  isFirst: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: view.id,
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 hover:bg-accent${
        isDragging ? " opacity-60 shadow" : ""
      }`}
    >
      <button
        type="button"
        className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="-my-2 flex flex-1 items-center gap-2 py-2 text-left"
      >
        <ConceptIcon value={view.icon || "lucide:LayoutDashboard"} size={16} />
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          {view.name || <span className="text-muted-foreground">(untitled view)</span>}
        </span>
        {view.ownerId && <Badge tone="gray">Personal</Badge>}
        {isFirst && <Badge tone="blue">Opens by default</Badge>}
      </button>
      <IconButton aria-label={`Delete ${view.name || "view"}`} onClick={onDelete}>
        <Trash2 size={15} />
      </IconButton>
    </div>
  )
}

/** The draft the General + Labels tabs edit; one Save persists it as a whole. */
interface Draft {
  name: string
  pluralName: string
  icon: string | null
  color: string | null
  description: string
  staticLabelIds: string[]
  defaultLabelIds: string[]
  versioningEnabled: boolean
  editReach: EditReach
}

/** Which destructive confirm dialog is open inside the modal (null = none). */
type ModalDialog =
  | { kind: "archiveField"; field: Field }
  | { kind: "deleteField"; field: Field }
  | { kind: "deleteItem"; inst: Instance }
  | null

/**
 * THE editing surface for a concept — a full-page tabbed editor that takes over
 * the settings content area, opened by selecting a node on the settings graph
 * canvas. General: identity (name, plural, icon, color, description),
 * versioning, danger zone. Labels: static/default label wiring. Fields: the
 * schema. Archived items: restore/purge.
 *
 * Identity, labels and versioning edit a local draft; one Save persists them
 * together (everything is a single `updateConcept`), Cancel/back returns to the
 * concept graph (a discard confirm fires on any nav away while dirty). Field and
 * archived-item operations are row-level APIs of their own and apply
 * immediately. Concept archive/restore/delete confirm at the page level — the
 * archived-concepts list shares those dialogs.
 */
export function ConceptEditor({
  concept,
  admin,
  concepts,
  onRequestArchive,
  onRequestDelete,
  onRestore,
  restorePending,
  restoreError,
}: {
  concept: Concept
  admin: boolean
  /** Every concept incl. archived — resolves relation targets and taken colors. */
  concepts: readonly Concept[]
  onRequestArchive: () => void
  onRequestDelete: () => void
  onRestore: () => void
  restorePending: boolean
  restoreError?: string
}) {
  usePageChrome({ fullWidth: true, fillHeight: true })
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Draft>(() => ({
    name: concept.name,
    pluralName: concept.pluralName ?? "",
    icon: concept.icon ?? null,
    color: concept.color ?? null,
    description: concept.description ?? "",
    staticLabelIds: [...concept.staticLabelIds],
    defaultLabelIds: [...concept.defaultLabelIds],
    versioningEnabled: concept.versioningEnabled,
    editReach: concept.editReach,
  }))
  const [dirty, setDirty] = useState(false)
  // Record-view deletion confirm (the Layout tab manages per-concept record views).
  const [confirmDeleteView, setConfirmDeleteView] = useState<string | null>(null)
  const { blocker, bypass } = useUnsavedGuard(dirty)
  // A `?tab=` deep-link (e.g. "Configure record view" from a record page) opens
  // that tab; defaults to General.
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState(() => searchParams.get("tab") ?? "general")
  const [colorOpen, setColorOpen] = useState(false)
  const [showArchivedFields, setShowArchivedFields] = useState(false)
  // Field add/edit happens in a nested modal; null = closed.
  const [fieldModal, setFieldModal] = useState<
    { mode: "add" } | { mode: "edit"; field: Field } | null
  >(null)
  const [dialog, setDialog] = useState<ModalDialog>(null)

  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }))
    setDirty(true)
  }

  const labelVocab = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })

  // Colors claimed by OTHER live concepts — the picker disables them so every
  // concept keeps a unique color.
  const takenColors = new Set(
    concepts.flatMap((c) =>
      c.id !== concept.id && !c.archivedAt && c.color ? [c.color.toLowerCase()] : [],
    ),
  )
  const liveConcepts = concepts.filter((c) => !c.archivedAt)
  // Resolve a relation target concept id → its display name for field summaries.
  const conceptName = (id: string) => concepts.find((c) => c.id === id)?.name ?? id

  // Concept names + relation fields drive the graph, so refresh it after every edit.
  const refetchGraph = () => qc.invalidateQueries({ queryKey: ["conceptGraph"] })

  const save = useMutation({
    // A static label is always applied, so it's never also a default.
    mutationFn: () =>
      api.updateConcept(concept.id, {
        name: draft.name.trim(),
        pluralName: draft.pluralName.trim() || null,
        description: draft.description.trim() || null,
        icon: draft.icon,
        color: draft.color,
        versioningEnabled: draft.versioningEnabled,
        editReach: draft.editReach,
        staticLabelIds: draft.staticLabelIds,
        defaultLabelIds: draft.defaultLabelIds.filter((id) => !draft.staticLabelIds.includes(id)),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["concepts"] })
      refetchGraph()
      bypass()
      navigate("/settings/concepts")
    },
  })
  const saveError = save.error
    ? msgOf(save.error) +
      (String(save.error).includes("VERSIONING_IN_USE") ||
      msgOf(save.error).includes("VersioningInUse")
        ? " — disabling versioning is blocked while items have multiple versions or an open draft."
        : "")
    : null

  // Distinct key from the live ["fields", id] used elsewhere (ConceptView): the
  // settings editor needs archived defs too, split client-side for display.
  const fields = useQuery({
    queryKey: ["fields", concept.id, "withArchived"],
    queryFn: () => api.listFields(concept.id, { includeArchived: true }),
  })
  const liveFields = fields.data?.filter((f) => !f.archivedAt) ?? []
  const archivedFields = fields.data?.filter((f) => f.archivedAt) ?? []
  // On a managed concept the integration's synced fields are read-only (pinned
  // first), while user-added fields (managedBy null) are fully editable — so a
  // member can add e.g. a status without touching the synced data.
  const isManaged = !!concept.managedBy
  const syncedFields = liveFields.filter((f) => f.managedBy)
  const userFields = liveFields.filter((f) => !f.managedBy)

  // Layout tab: the concept's RECORD VIEWS — per-concept dashboards that render
  // one instance at a time. Editing happens on the dashboard-editor route; this
  // tab lists them in order (the FIRST opens by default; drag to reorder).
  // (Replaces the old instance_view tile layout.)
  const recordDashboards = useQuery({
    queryKey: ["recordDashboards", concept.id],
    queryFn: () => api.listRecordDashboards(concept.id),
  })
  const invalidateViews = () => {
    qc.invalidateQueries({ queryKey: ["recordDashboards", concept.id] })
    qc.invalidateQueries({ queryKey: ["dashboards"] }) // the settings list (["dashboards","all"])
  }
  const createRecordView = useMutation({
    mutationFn: () =>
      api.createDashboard({
        name: "New view",
        scope: "org",
        kind: "record",
        conceptId: concept.id,
        body: { widgets: [] },
      }),
    onSuccess: (d) => {
      invalidateViews()
      navigate(`/settings/dashboards/${d.id}?concept=${concept.id}`)
    },
  })
  const reorderRecordViews = useMutation({
    mutationFn: (orders: { id: string; position: number }[]) => api.reorderDashboards(orders),
    onSuccess: invalidateViews,
  })
  const onViewDragEnd = (e: DragEndEvent) => {
    const views = recordDashboards.data ?? []
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = views.findIndex((d) => d.id === active.id)
    const to = views.findIndex((d) => d.id === over.id)
    if (from < 0 || to < 0) return
    reorderRecordViews.mutate(
      arrayMove([...views], from, to).map((d, i) => ({ id: d.id, position: i })),
    )
  }
  const deleteRecordView = useMutation({
    mutationFn: (id: string) => api.deleteDashboard(id),
    onSuccess: () => {
      setConfirmDeleteView(null)
      invalidateViews()
    },
  })

  // Title field saves immediately (no draft) — like the layout, it's its own RPC.
  const saveTitleField = useMutation({
    mutationFn: (titleFieldId: string | null) => api.setConceptTitleField(concept.id, titleFieldId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["concepts"] })
      refetchGraph()
    },
  })

  const refetchFields = () => {
    qc.invalidateQueries({ queryKey: ["fields", concept.id, "withArchived"] })
    // Keep the live list other views read (ConceptView columns) fresh too.
    qc.invalidateQueries({ queryKey: ["fields", concept.id] })
  }

  const addField = useMutation({
    mutationFn: (v: FieldFormValue) =>
      api.addField({
        conceptId: concept.id,
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
      api.reorderFields(concept.id, orders),
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
    qc.setQueryData<Field[]>(["fields", concept.id, "withArchived"], (old) => {
      if (!old) return old
      const rank = new Map(next.map((f, i) => [f.id, i]))
      return [...old].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
    })
    reorderFieldsMut.mutate(next.map((f, i) => ({ id: f.id, position: i })))
  }

  // Managed concept: reorder among USER fields only (synced stay pinned first);
  // positions are assigned over the full [synced…, user…] order so they never
  // collide with the synced fields' positions.
  const onUserFieldDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = userFields.findIndex((f) => f.id === active.id)
    const to = userFields.findIndex((f) => f.id === over.id)
    if (from < 0 || to < 0) return
    const next = [...syncedFields, ...arrayMove(userFields, from, to)]
    qc.setQueryData<Field[]>(["fields", concept.id, "withArchived"], (old) => {
      if (!old) return old
      const rank = new Map(next.map((f, i) => [f.id, i]))
      return [...old].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
    })
    reorderFieldsMut.mutate(next.map((f, i) => ({ id: f.id, position: i })))
  }

  // Archived items: restore, or purge (admin) — the data-hygiene side of a
  // concept, so it lives here with the rest of its configuration.
  const archivedItems = useQuery({
    queryKey: ["instances", concept.id, "archived"],
    queryFn: () => api.listInstances(concept.id, { includeArchived: true }),
    select: (rows) => rows.filter((i) => i.archivedAt),
  })
  const refetchArchived = () =>
    qc.invalidateQueries({ queryKey: ["instances", concept.id, "archived"] })
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
      {/* The title field (its value names each item) carries a read-only badge;
          you change which field it is from the field's edit modal. */}
      {!archived && concept.titleFieldId === f.id && (
        <span
          className="flex items-center gap-1 text-xs font-medium text-primary"
          title="Title field — its value names each item"
        >
          <Star size={13} className="fill-current" />
          Title
        </span>
      )}
      {/* Synced (integration-owned) fields are read-only — show a lock, no actions. */}
      {f.managedBy ? (
        <span
          className="flex items-center gap-1 text-xs text-muted-foreground"
          title="Synced from the integration — read-only"
        >
          <Lock size={13} />
          Synced
        </span>
      ) : (
        admin &&
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
        ))
      )}
    </>
  )

  /** A non-sortable field row (archived rows, or live rows for non-admins). */
  const renderFieldRow = (f: Field, archived: boolean) => (
    <li key={f.id} className={`flex items-center gap-2 py-2.5${archived ? " opacity-60" : ""}`}>
      {fieldRowBody(f, archived)}
    </li>
  )

  const archivedCount = archivedItems.data?.length ?? 0
  // The items tab disappears with its last row (restore/purge) — fall back.
  const activeTab = tab === "items" && archivedCount === 0 ? "general" : tab

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 pb-3 text-base font-medium text-foreground">
        <button
          type="button"
          onClick={() => navigate("/settings/concepts")}
          className="truncate text-muted-foreground hover:text-foreground"
        >
          Concepts
        </button>
        <span className="text-muted-foreground/50">/</span>
        <ConceptIcon value={draft.icon || DEFAULT_CONCEPT_ICON} size={16} />
        <span className="truncate">{draft.name.trim() || "Untitled concept"}</span>
        {concept.archivedAt && <Badge tone="amber">Archived</Badge>}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <Tabs value={activeTab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
          <TabBar>
            <TabBarItem value="general" icon={<SlidersHorizontal size={16} />}>
              General
            </TabBarItem>
            <TabBarItem value="fields" icon={<Columns3 size={16} />}>
              Fields
            </TabBarItem>
            {/* Managed concepts render the integration's own detail view, so a
                custom layout would never show — hide the tab for them. */}
            {!concept.managedBy && (
              <TabBarItem value="layout" icon={<LayoutDashboard size={16} />}>
                Layout
              </TabBarItem>
            )}
            {archivedCount > 0 && (
              <TabBarItem value="items" icon={<Archive size={16} />}>
                Archived items ({archivedCount})
              </TabBarItem>
            )}
          </TabBar>

          <TabsContent value="general" className="min-h-0 flex-1 overflow-y-auto pt-4 pb-24">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 space-y-1.5">
                  <span className="block text-sm leading-none font-medium text-foreground">
                    Name
                  </span>
                  <Input
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    disabled={!admin}
                  />
                </div>
                <div className="flex-1 space-y-1.5">
                  <span className="flex items-center gap-1.5 text-sm leading-none font-medium text-foreground">
                    Plural name
                    <InfoHint
                      text="Shown in the sidebar; falls back to the singular name when blank."
                      label="Plural name — more info"
                    />
                  </span>
                  <Input
                    value={draft.pluralName}
                    onChange={(e) => patch({ pluralName: e.target.value })}
                    disabled={!admin}
                    placeholder={draft.name ? `${draft.name}s` : "Plural name…"}
                  />
                </div>
                <div className="space-y-1.5">
                  <span className="block text-sm leading-none font-medium text-foreground">
                    Icon
                  </span>
                  <IconPicker
                    value={draft.icon}
                    onChange={(icon) => patch({ icon })}
                    disabled={!admin}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <span className="flex items-center gap-1.5 text-sm leading-none font-medium text-foreground">
                  Color
                  <InfoHint
                    text="Tints this concept's items in the relationship graph; none renders neutral."
                    label="Color — more info"
                  />
                </span>
                <Popover open={colorOpen} onOpenChange={setColorOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" disabled={!admin}>
                      {draft.color ? (
                        <LabelChip color={draft.color}>{colorNameOf(draft.color)}</LabelChip>
                      ) : (
                        <span className="text-muted-foreground">No color</span>
                      )}
                      <ChevronDown className="text-muted-foreground" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-auto max-w-80 space-y-3">
                    <ColorSwatchPicker
                      label="Concept color"
                      preview={draft.name.trim() || "Concept"}
                      value={draft.color}
                      taken={takenColors}
                      onChange={(hex) => {
                        patch({ color: hex })
                        setColorOpen(false)
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        patch({ color: null })
                        setColorOpen(false)
                      }}
                    >
                      No color
                    </Button>
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-1.5">
                <span className="block text-sm leading-none font-medium text-foreground">
                  Description
                </span>
                <Textarea
                  value={draft.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  rows={2}
                  disabled={!admin}
                />
              </div>

              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="versioning-toggle"
                    checked={draft.versioningEnabled}
                    disabled={!admin}
                    onCheckedChange={(v) => patch({ versioningEnabled: v === true })}
                  />
                  <label
                    htmlFor="versioning-toggle"
                    className="text-sm font-medium text-foreground"
                  >
                    Enable versioning
                  </label>
                  <InfoHint
                    text={`Items hold multiple draft → published versions. New items start as a draft and aren't shown or referenceable until published; lists show only the latest published version. Other items can reference "Latest" or pin a specific version.`}
                    label="Enable versioning — more info"
                  />
                </div>

                {/* Reach is subordinate to versioning — with versioning off every row
                    is editable anyway, so the control is dead and reads disabled. */}
                <div className="flex items-center gap-3 pl-7">
                  <span className="text-sm text-muted-foreground">Editable versions</span>
                  <Select
                    value={draft.editReach}
                    disabled={!admin || !draft.versioningEnabled}
                    onValueChange={(v) => patch({ editReach: v as EditReach })}
                  >
                    <SelectTrigger className="w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft only</SelectItem>
                      <SelectItem value="any">Any version — allow amendments</SelectItem>
                    </SelectContent>
                  </Select>
                  <InfoHint
                    text={`"Draft only" freezes a version once published — changes need a new draft. "Any version" lets a published version be amended in place, e.g. to fix a typo. An amendment is live immediately to everyone referencing that version, including items pinned to it, and is recorded in the activity feed as "amended this version".`}
                    label="Editable versions — more info"
                  />
                </div>
              </div>

              <div className="space-y-3 border-t border-border pt-4">
                <span className="block text-sm leading-none font-medium text-foreground">
                  Labels
                </span>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5 rounded-md border border-border p-3">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      Always applied (static)
                      <InfoHint
                        text="Inherited by every item of this concept; can't be removed per item."
                        label="Always applied labels — more info"
                      />
                    </span>
                    {admin ? (
                      <LabelMultiSelect
                        all={labelVocab.data ?? []}
                        selectedIds={draft.staticLabelIds}
                        onChange={(ids) => patch({ staticLabelIds: ids })}
                      />
                    ) : (
                      <ReadOnlyLabels ids={concept.staticLabelIds} vocab={labelVocab.data ?? []} />
                    )}
                  </div>
                  <div className="space-y-1.5 rounded-md border border-border p-3">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      Default on new items
                      <InfoHint
                        text="Pre-applied when an item is created; editable per item afterward."
                        label="Default labels — more info"
                      />
                    </span>
                    {admin ? (
                      <LabelMultiSelect
                        all={labelVocab.data ?? []}
                        selectedIds={draft.defaultLabelIds}
                        onChange={(ids) => patch({ defaultLabelIds: ids })}
                        excludeIds={draft.staticLabelIds}
                      />
                    ) : (
                      <ReadOnlyLabels ids={concept.defaultLabelIds} vocab={labelVocab.data ?? []} />
                    )}
                  </div>
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
              </div>

              {admin && (
                <Card className="border-destructive/40">
                  <CardHeader title={<span className="text-destructive">Danger zone</span>} />
                  <div className="divide-y divide-border">
                    {concept.archivedAt ? (
                      <div className="flex items-center justify-between gap-4 px-4 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            Restore this concept
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Brings it back to the sidebar, lists, and graph.
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
                          <p className="text-sm font-medium text-foreground">
                            Archive this concept
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Hides it from the sidebar and lists; its fields
                            {concept.itemCount
                              ? ` and ${concept.itemCount} item${concept.itemCount === 1 ? "" : "s"}`
                              : ""}{" "}
                            are kept. Restore anytime.
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={onRequestArchive}
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
                        onClick={onRequestDelete}
                      >
                        <Trash2 size={14} />
                        Delete
                      </Button>
                    </div>
                  </div>
                  {restoreError && (
                    <p className="px-4 pb-3 text-sm text-destructive">{restoreError}</p>
                  )}
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="fields" className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6 pb-24">
              {fields.isPending && <Spinner />}
              {!fields.isPending && liveFields.length === 0 && (
                <p className="text-xs text-muted-foreground">No fields yet.</p>
              )}
              {liveFields.length > 0 &&
                (isManaged ? (
                  <div className="space-y-5">
                    <p className="text-xs text-muted-foreground">
                      Synced fields are owned by the integration and read-only. Add your own fields
                      to annotate these records (e.g. a status) — they stay yours and are fully
                      editable.
                    </p>
                    {syncedFields.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Synced fields
                        </p>
                        <ul className="divide-y divide-border">
                          {syncedFields.map((f) => renderFieldRow(f, false))}
                        </ul>
                      </div>
                    )}
                    <div className="space-y-1">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Your fields
                      </p>
                      {userFields.length === 0 ? (
                        <p className="py-1 text-xs text-muted-foreground">
                          No custom fields yet.{admin ? " Add one below." : ""}
                        </p>
                      ) : admin ? (
                        <DndContext
                          sensors={sensors}
                          collisionDetection={closestCenter}
                          onDragEnd={onUserFieldDragEnd}
                        >
                          <SortableContext
                            items={userFields.map((f) => f.id)}
                            strategy={verticalListSortingStrategy}
                          >
                            <ul className="divide-y divide-border">
                              {userFields.map((f) => (
                                <SortableFieldRow key={f.id} field={f}>
                                  {fieldRowBody(f, false)}
                                </SortableFieldRow>
                              ))}
                            </ul>
                          </SortableContext>
                        </DndContext>
                      ) : (
                        <ul className="divide-y divide-border">
                          {userFields.map((f) => renderFieldRow(f, false))}
                        </ul>
                      )}
                    </div>
                  </div>
                ) : admin ? (
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
              {admin && (
                <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFieldModal({ mode: "add" })}
                  >
                    <Plus size={15} />
                    Add field
                  </Button>
                  {archivedFields.length > 0 && (
                    <Button
                      variant="link"
                      onClick={() => setShowArchivedFields((v) => !v)}
                      className="h-auto p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
                    >
                      {showArchivedFields ? "Hide" : "Show"} archived ({archivedFields.length})
                    </Button>
                  )}
                </div>
              )}
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
          </TabsContent>

          {!concept.managedBy && (
            <TabsContent value="layout" className="flex min-h-0 flex-1 flex-col pt-4">
              <div className="flex shrink-0 items-start justify-between gap-3 pb-3">
                <p className="text-xs text-muted-foreground">
                  Record views for {concept.name} — each is a dashboard that lays out a single item
                  (its fields, related records, notes, and more). Drag to reorder; the top view is
                  what a record opens with unless a reference asks for a specific one.
                </p>
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() => createRecordView.mutate()}
                  disabled={createRecordView.isPending}
                >
                  <Plus size={15} /> New view
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {!recordDashboards.data ? (
                  <Spinner />
                ) : recordDashboards.data.length === 0 ? (
                  <Card className="p-6 text-sm text-muted-foreground">
                    No record views yet — items render the built-in default layout. Create a view to
                    design how a {concept.name} looks.
                  </Card>
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={onViewDragEnd}
                  >
                    <SortableContext
                      items={recordDashboards.data.map((d) => d.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-1.5">
                        {recordDashboards.data.map((d, i) => (
                          <RecordViewRow
                            key={d.id}
                            view={d}
                            isFirst={i === 0}
                            onOpen={() =>
                              navigate(`/settings/dashboards/${d.id}?concept=${concept.id}`)
                            }
                            onDelete={() => setConfirmDeleteView(d.id)}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}
                {(createRecordView.error || reorderRecordViews.error) && (
                  <p className="pt-2 text-sm text-destructive">
                    {msgOf(createRecordView.error || reorderRecordViews.error)}
                  </p>
                )}
              </div>
            </TabsContent>
          )}

          {archivedCount > 0 && (
            <TabsContent value="items" className="min-h-0 flex-1 overflow-y-auto pt-4 pb-24">
              <ul className="divide-y divide-border">
                {archivedItems.data!.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 py-2 opacity-80">
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
                <p className="pt-3 text-sm text-destructive">{msgOf(restoreItem.error)}</p>
              )}
            </TabsContent>
          )}
        </Tabs>

        <div className="pointer-events-none absolute right-6 bottom-6 z-10 flex flex-col items-end gap-2">
          {saveError && (
            <p className="pointer-events-auto max-w-md rounded-md border border-destructive/30 bg-background px-3 py-2 text-xs text-destructive shadow-lg">
              {saveError}
            </p>
          )}
          <div className="pointer-events-auto flex gap-2">
            {admin ? (
              <>
                <Button
                  variant="outline"
                  className="shadow-lg"
                  onClick={() => navigate("/settings/concepts")}
                >
                  Cancel
                </Button>
                <Button
                  className="shadow-lg"
                  onClick={() => save.mutate()}
                  disabled={save.isPending || !draft.name.trim()}
                >
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                className="shadow-lg"
                onClick={() => navigate("/settings/concepts")}
              >
                Close
              </Button>
            )}
          </div>
        </div>
      </div>

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
          {/* Title field is a concept-level setting; offered per field here (edit
              only — a new field has no id yet). Saves immediately via its own RPC.
              Managed concepts own their title, so it isn't offered there. */}
          {fieldModal.mode === "edit" &&
            !concept.managedBy &&
            fieldModal.field.kind !== "relation" &&
            fieldModal.field.kind !== "file" && (
              <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
                <Checkbox
                  id="title-field-toggle"
                  checked={concept.titleFieldId === fieldModal.field.id}
                  disabled={!admin || saveTitleField.isPending}
                  onCheckedChange={(v) =>
                    saveTitleField.mutate(v === true ? fieldModal.field.id : null)
                  }
                />
                <label htmlFor="title-field-toggle" className="text-sm font-medium text-foreground">
                  Use as the title field
                </label>
                <InfoHint
                  text="Its value names each item — shown as the label in lists, the calendar, relation pickers, and elsewhere."
                  label="Title field — more info"
                />
              </div>
            )}
          {(addField.error || updateField.error || saveTitleField.error) && (
            <p className="mt-3 text-sm text-destructive">
              {msgOf(addField.error ?? updateField.error ?? saveTitleField.error)}
            </p>
          )}
        </Modal>
      )}

      {blocker.state === "blocked" && (
        <ConfirmDialog
          title="Discard changes?"
          message="Your edits to this concept haven't been saved."
          confirmLabel="Discard"
          confirmVariant="danger"
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        />
      )}
      {confirmDeleteView && (
        <ConfirmDialog
          title="Delete record view?"
          message="This view and its layout will be permanently deleted. Items keep rendering with the remaining views (or the built-in default)."
          confirmLabel="Delete"
          confirmVariant="danger"
          pending={deleteRecordView.isPending}
          error={deleteRecordView.error ? msgOf(deleteRecordView.error) : undefined}
          onConfirm={() => deleteRecordView.mutate(confirmDeleteView)}
          onCancel={() => setConfirmDeleteView(null)}
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
    </div>
  )
}
