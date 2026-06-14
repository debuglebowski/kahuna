import { useMutation, useQuery } from "@tanstack/react-query"
import { Lock, LockOpen, Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { InstanceTable } from "@/components/InstanceTable"
import { Badge, IconButton, Modal, Spinner } from "@/components/ui"
import { api, type Concept, type DashboardWidget, type Field, type Instance } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { instancesByConcept } from "@/lib/collections"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { FieldValueCell } from "@/lib/fieldDisplay"
import { useQuickEdit } from "@/lib/quickEdit"
import { cn, showValue } from "@/lib/utils"
import { matchInstance } from "@/lib/widgetAggregations"
import { InstanceForm } from "@/pages/InstanceForm"

type List = Extract<DashboardWidget, { type: "list" }>

/** Instances of a concept matching the widget's filter, as the real instance
 *  table — the canonical way to browse/edit a concept's data. Carries its own
 *  create ("+") action and the per-user sticky quick-edit mode. */
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

  const variant = widget.variant ?? "auto"
  const cards = variant === "cards" || (variant === "auto" && widget.layout.w < 5)

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
  // sits on the same row as the toolbar actions.
  const heading = widget.title?.trim() || concept?.name || ""

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
      <div className="-mx-1 min-h-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">No matching items.</p>
        ) : cards ? (
          <div className="space-y-1.5 px-1">
            {rows.map((i) => (
              <InstanceCard
                key={i.id}
                inst={i}
                columns={columns}
                onOpen={() => navigate(`/instances/${i.id}`)}
              />
            ))}
          </div>
        ) : (
          <InstanceTable
            columns={columns}
            rows={rows}
            quickEdit={quickEdit}
            onSaveCell={onSaveCell}
            defaultSortKey={widget.orderBy ?? null}
            dense
          />
        )}
      </div>
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

/** Narrow-tile row: first column as the title, the next few as a meta line. */
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
