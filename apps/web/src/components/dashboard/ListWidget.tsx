import { useMutation, useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, Lock, LockOpen, Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { InstanceTable } from "@/components/InstanceTable"
import { Badge, IconButton, Modal, Spinner } from "@/components/ui"
import { api, type Concept, type DashboardWidget, type Field, type Instance } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { instancesByConcept } from "@/lib/collections"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { capitalize, FieldValueCell } from "@/lib/fieldDisplay"
import { useQuickEdit } from "@/lib/quickEdit"
import { cn, showValue } from "@/lib/utils"
import { resolveVariantId } from "@/lib/variantCatalog"
import { kanbanBuckets, matchInstance } from "@/lib/widgetAggregations"
import { InstanceForm } from "@/pages/InstanceForm"

type List = Extract<DashboardWidget, { type: "list" }>

/** An enum field's option color for a value (first of a multi value), or null. */
const optionColorFor = (field: Field, value: unknown): string | null => {
  if (field.kind !== "enum") return null
  const first = Array.isArray(value) ? value[0] : value
  if (first == null || first === "") return null
  return field.config.optionColors?.[String(first)] ?? null
}

/** An enum field's configured option order (empty for non-enum). */
const optionsOf = (field: Field): readonly string[] =>
  field.kind === "enum" ? (field.config.options ?? []) : []

/** Instances of a concept matching the widget's filter. Six presentations chosen
 *  by `variant`: a real instance `table` (inline quick-edit), stacked `cards`, a
 *  compact `rows` feed (status dot + meta), `grouped` collapsible sections, a
 *  `gallery` tile grid, or `auto` (table on wide tiles, cards otherwise). Carries
 *  its own create ("+") action and the per-user sticky quick-edit mode. */
export function ListWidget({
  widget,
  data,
  concept,
}: {
  widget: List
  data: ConceptInstanceData | undefined
  concept: Concept | undefined
}) {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const me = session?.user.id ?? null
  const fields = data?.fields ?? []
  const conceptId = widget.conceptId ?? ""
  const [quickEdit, toggleQuickEdit] = useQuickEdit(conceptId)
  const [adding, setAdding] = useState(false)
  const archived = widget.archived ?? "exclude"

  // The live collection excludes archived rows; include/only pull them via a
  // plain query (same pattern as the Kanban board's archived toggle).
  const archivedQ = useQuery({
    queryKey: ["list-archived", conceptId],
    queryFn: () => api.listInstances(conceptId, { includeArchived: true }),
    enabled: archived !== "exclude" && !!conceptId,
  })

  // Columns: explicit selection, else the concept's scalar fields (no relation/file).
  const columns = useMemo(() => {
    const visible = fields.filter((f) => f.kind !== "relation" && f.kind !== "file")
    return widget.columns && widget.columns.length > 0
      ? widget.columns.map((id) => visible.find((f) => f.id === id)).filter((f) => !!f)
      : visible
  }, [fields, widget.columns])

  const rows = useMemo(() => {
    const archivedRows = (archivedQ.data ?? []).filter((i) => i.archivedAt != null)
    const pool =
      archived === "only"
        ? archivedRows
        : archived === "include"
          ? [...(data?.instances ?? []), ...archivedRows]
          : (data?.instances ?? [])
    let r = pool.filter((i) => matchInstance(i, widget.conditions, { match: widget.match, me }))
    if (widget.orderBy) {
      const key = widget.orderBy
      r = [...r].sort((a, b) => showValue(a.state[key]).localeCompare(showValue(b.state[key])))
    }
    if (widget.limit && widget.limit > 0) r = r.slice(0, widget.limit)
    return r
  }, [
    data?.instances,
    archived,
    archivedQ.data,
    widget.conditions,
    widget.match,
    me,
    widget.orderBy,
    widget.limit,
  ])

  // Resolve the variant. `auto` was the removed adaptive default; any legacy
  // widget still carrying it falls back to the table.
  const resolved = resolveVariantId(widget)
  const variant = resolved && resolved !== "auto" ? resolved : "table"

  // Enum field backing the status dot (rows) and the grouping sections (grouped);
  // an explicit pick wins, else the first enum field on the concept.
  const enumFields = fields.filter((f) => f.kind === "enum")
  const statusField =
    fields.find((f) => f.id === widget.statusField && f.kind === "enum") ?? enumFields[0]
  // No implicit default: grouping needs an explicit field (auto-picking one would
  // silently section by a surprise field), so an unset/invalid groupBy prompts.
  const groupField = fields.find((f) => f.id === widget.groupBy && f.kind === "enum")

  const open = (i: Instance) => navigate(`/instances/${i.id}`)
  const titleCol = columns[0]

  // One field saved per edit; refetch (success or fail) reconciles value + version.
  const onSaveCell = async (inst: Instance, fieldId: string, value: unknown) => {
    try {
      await api.updateInstance(inst.id, inst.version, { [fieldId]: value })
    } finally {
      instancesByConcept(conceptId).utils.refetch()
    }
  }

  const create = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.createInstance(conceptId, values),
    onSuccess: (created) => {
      setAdding(false)
      create.reset()
      instancesByConcept(conceptId).utils.refetch()
      // On a versioned concept the new item is an unpublished draft — invisible
      // in this head-only list — so go straight to its detail page to edit/publish.
      if (concept?.versioningEnabled) navigate(`/instances/${created.id}`)
    },
  })

  if (!widget.conceptId) return <p className="text-sm text-muted-foreground">Pick a concept.</p>

  // List renders its own title (the chrome header is suppressed for lists) so it
  // sits on the same row as the toolbar actions. Empty title → empty (no fallback).
  const heading = widget.title?.trim() || ""

  let body: React.ReactNode
  if (variant === "grouped" && !groupField) {
    body = (
      <p className="px-1 text-sm text-muted-foreground">
        {enumFields.length > 0 ? "Pick a field to group by." : "Add an enum field to group by."}
      </p>
    )
  } else if (rows.length === 0) {
    body = <p className="px-1 text-sm text-muted-foreground">No matching items.</p>
  } else if (variant === "table") {
    body = (
      <InstanceTable
        columns={columns}
        rows={rows}
        quickEdit={quickEdit}
        onSaveCell={onSaveCell}
        defaultSortKey={widget.orderBy ?? null}
        dense
        fill
      />
    )
  } else if (variant === "cards") {
    body = (
      <div className="space-y-1.5 px-1">
        {rows.map((i) => (
          <InstanceCard key={i.id} inst={i} columns={columns} onOpen={() => open(i)} />
        ))}
      </div>
    )
  } else if (variant === "gallery") {
    body = (
      <div
        className="grid gap-1.5 px-1"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
      >
        {rows.map((i) => (
          <InstanceCard key={i.id} inst={i} columns={columns} onOpen={() => open(i)} />
        ))}
      </div>
    )
  } else if (variant === "grouped" && groupField) {
    body = <GroupedRows rows={rows} columns={columns} groupField={groupField} onOpen={open} />
  } else {
    // `rows` (or any unknown variant) → a flat compact feed; only `rows` dots.
    const dotField = variant === "rows" ? statusField : undefined
    const metaCols = columns
      .slice(1)
      .filter((f) => f.id !== dotField?.id)
      .slice(0, 3)
    body = (
      <div className="space-y-0.5 px-1">
        {rows.map((i) => (
          <InstanceRow
            key={i.id}
            inst={i}
            titleCol={titleCol}
            metaCols={metaCols}
            dot={dotField ? optionColorFor(dotField, i.state[dotField.id]) : false}
            onOpen={() => open(i)}
          />
        ))}
      </div>
    )
  }

  return (
    // cancel-drag: clicks/edits inside the table must never start a tile drag.
    <div className="cancel-drag flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 pb-1">
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {heading}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            aria-label={quickEdit ? "Lock editing" : "Unlock editing"}
            className={cn(quickEdit && "text-primary ring-1 ring-primary/40")}
            onClick={() => toggleQuickEdit(!quickEdit)}
          >
            {quickEdit ? (
              <LockOpen size={13} fill="currentColor" fillOpacity={0.2} />
            ) : (
              <Lock size={13} fill="currentColor" fillOpacity={0.2} />
            )}
          </IconButton>
          <IconButton
            aria-label={`New ${concept?.name ?? "instance"}`}
            onClick={() => setAdding(true)}
          >
            <Plus size={14} />
          </IconButton>
        </div>
      </div>
      <div className="-mx-1 min-h-0 flex-1 overflow-auto">{body}</div>
      {adding && (
        <Modal title={`New ${concept?.name ?? "instance"}`} onClose={() => setAdding(false)}>
          {!data ? (
            <Spinner />
          ) : (
            <InstanceForm
              fields={fields}
              defaultLabelIds={concept?.defaultLabelIds ?? []}
              onSubmit={(v) => create.mutate(v)}
              onCancel={() => setAdding(false)}
              pending={create.isPending}
            />
          )}
          {create.error && (
            <p className="mt-3 text-sm text-destructive">
              {(create.error as { message?: string }).message ?? "Could not create."}
            </p>
          )}
        </Modal>
      )}
    </div>
  )
}

/** Narrow-tile / gallery card: first column as the title, the next few as a meta line. */
function InstanceCard({
  inst,
  columns,
  onOpen,
}: {
  inst: Instance
  columns: readonly Field[]
  onOpen: () => void
}) {
  const [title, ...rest] = columns
  const meta = rest
    .slice(0, 3)
    .map((f) => ({ f, v: inst.state[f.id] }))
    .filter(({ v }) => v !== null && v !== undefined && v !== "")
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full rounded-md border border-border bg-card p-2 text-left shadow-xs hover:bg-accent/40"
    >
      <div className="flex items-start justify-between gap-1">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {title ? showValue(inst.state[title.id]) || "—" : "—"}
        </span>
        {inst.archivedAt != null && <Badge tone="amber">Archived</Badge>}
      </div>
      {meta.length > 0 && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 truncate text-xs text-muted-foreground">
          {meta.map(({ f, v }) => (
            <span key={f.id} className="inline-flex max-w-44 items-center truncate">
              <FieldValueCell field={f} value={v} />
            </span>
          ))}
        </div>
      )}
    </button>
  )
}

/** One borderless line: optional leading status dot (`false` = no dot column,
 *  `null` = neutral, hex = the enum option color), the title, then right-aligned
 *  field cells. Used by the `rows` feed and inside `grouped` sections. */
function InstanceRow({
  inst,
  titleCol,
  metaCols,
  dot,
  onOpen,
}: {
  inst: Instance
  titleCol: Field | undefined
  metaCols: readonly Field[]
  dot: string | null | false
  onOpen: () => void
}) {
  const meta = metaCols
    .map((f) => ({ f, v: inst.state[f.id] }))
    .filter(({ v }) => v !== null && v !== undefined && v !== "")
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
    >
      {dot !== false &&
        (dot ? (
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} />
        ) : (
          <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
        ))}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {titleCol ? showValue(inst.state[titleCol.id]) || "—" : "—"}
      </span>
      {inst.archivedAt != null && <Badge tone="amber">Archived</Badge>}
      {meta.length > 0 && (
        <span className="flex shrink-0 items-center gap-2 truncate text-xs text-muted-foreground">
          {meta.map(({ f, v }) => (
            <span key={f.id} className="inline-flex max-w-40 items-center truncate">
              <FieldValueCell field={f} value={v} />
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

/** Rows sectioned by an enum field into collapsible groups, each with a count.
 *  Sections follow the field's configured option order; the no-value bucket
 *  sorts last. Collapse state is ephemeral (per mount). */
function GroupedRows({
  rows,
  columns,
  groupField,
  onOpen,
}: {
  rows: readonly Instance[]
  columns: readonly Field[]
  groupField: Field
  onOpen: (i: Instance) => void
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const titleCol = columns[0]
  const metaCols = columns
    .slice(1)
    .filter((f) => f.id !== groupField.id)
    .slice(0, 3)

  // kanbanBuckets keys by the enum value ("" = no value), preserving row order
  // within each bucket. Order sections by the field's option order, no-value last.
  const buckets = useMemo(() => kanbanBuckets(rows, [], groupField.id), [rows, groupField.id])
  const order = useMemo(() => {
    const pos = new Map(optionsOf(groupField).map((o, i) => [o, i] as const))
    return [...buckets.keys()].sort((a, b) => {
      if (a === b) return 0
      if (a === "") return 1
      if (b === "") return -1
      const pa = pos.get(a)
      const pb = pos.get(b)
      if (pa != null && pb != null) return pa - pb
      if (pa != null) return -1
      if (pb != null) return 1
      return a.localeCompare(b)
    })
  }, [buckets, groupField])

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  return (
    <div className="space-y-2 px-1">
      {order.map((key) => {
        const items = buckets.get(key) ?? []
        const isCollapsed = collapsed.has(key)
        const color = key === "" ? null : optionColorFor(groupField, key)
        return (
          <div key={key}>
            <button
              type="button"
              onClick={() => toggle(key)}
              className="flex w-full items-center gap-1.5 rounded-md py-0.5 text-left hover:bg-accent/40"
            >
              {isCollapsed ? (
                <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
              )}
              {color && (
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
              )}
              <span className="truncate text-xs font-medium text-foreground">
                {key === "" ? "No value" : capitalize(key)}
              </span>
              <span className="text-xs text-muted-foreground">· {items.length}</span>
            </button>
            {!isCollapsed && (
              <div className="mt-0.5 space-y-0.5">
                {items.map((i) => (
                  <InstanceRow
                    key={i.id}
                    inst={i}
                    titleCol={titleCol}
                    metaCols={metaCols}
                    dot={false}
                    onOpen={() => onOpen(i)}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
