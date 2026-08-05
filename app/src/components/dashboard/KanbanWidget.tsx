import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import { useQuery } from "@tanstack/react-query"
import { type ReactNode, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import { Badge, LabelChip } from "@/components/ui"
import { api, type Concept, type DashboardWidget, type Field, type RecordVersion } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { recordsByConcept } from "@/lib/collections"
import type { ConceptRecordData } from "@/lib/conceptData"
import { capitalize, FieldValueCell } from "@/lib/fieldDisplay"
import { recordHref } from "@/lib/recordHref"
import { recordLabel } from "@/lib/recordLabel"
import { isRichTextEmpty } from "@/lib/richtext"
import { cn, showValue } from "@/lib/utils"
import { kanbanBuckets } from "@/lib/widgetAggregations"

type Kanban = Extract<DashboardWidget, { type: "kanban" }>

/** Column droppable ids carry their enum value ("" = the no-value column). */
const colUid = (value: string) => `col:${value}`
const colValue = (uid: string) => uid.slice(4)

const isEmptyValue = (field: Field, v: unknown): boolean =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (field.kind === "richtext" && isRichTextEmpty(v))

/** Engine errors surface as raw JSON payloads — map the enum-transition shape
 *  ({ field, from, to, allowed }) to a readable line, else show the text. */
const moveErrorText = (err: unknown): string => {
  const msg = (err as { message?: string }).message ?? ""
  try {
    const o = JSON.parse(msg) as { from?: unknown; to?: unknown; allowed?: unknown }
    if (Array.isArray(o.allowed)) {
      const allowed = o.allowed.length > 0 ? o.allowed.map(capitalize).join(", ") : "nothing"
      return `“${capitalize(String(o.from ?? "—"))}” can only move to: ${allowed}.`
    }
  } catch {
    // not a JSON payload — fall through to the plain message
  }
  return msg ? msg.slice(0, 200) : "Couldn't move the card."
}

/**
 * Record versions as cards in columns keyed by an enum field; dragging a card to
 * another column writes that value through the record version-update RPC (dropping
 * on "No value" clears via explicit null). The optimistic move lives in a
 * local override until the collection refetch confirms or reverts it. Card
 * drags never fight the canvas: view-mode RGL is frozen, and in the edit
 * modal the whole board is `cancel-drag`.
 */
export function KanbanWidget({
  widget,
  data,
  concept,
}: {
  widget: Kanban
  data: ConceptRecordData | undefined
  /** The board's concept — its title field drives card labels. */
  concept?: Concept
}) {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const me = session?.user.id ?? null
  const conceptId = widget.conceptId ?? ""
  const fields = data?.fields ?? []
  const groupField = fields.find((f) => f.id === widget.groupBy)
  const includeArchived = widget.includeArchived ?? false
  const dragToUpdate = widget.dragToUpdate ?? true

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const [activeId, setActiveId] = useState<string | null>(null)
  // instanceId -> column value ("" clears): shown until the refetch reconciles.
  const [pending, setPending] = useState<Record<string, string>>({})
  const [moveError, setMoveError] = useState<string | null>(null)
  // A completed drag still fires a click on the source card — swallow that one.
  const suppressClick = useRef(false)

  // The live collection excludes archived rows; the opt-in pulls them via a
  // plain query (archived cards are read-only, so staleness is harmless).
  const archivedQ = useQuery({
    queryKey: ["kanban-archived", conceptId],
    queryFn: () => api.listRecords(conceptId, { includeArchived: true }),
    enabled: includeArchived && !!conceptId,
  })

  const recordVersions = useMemo(() => {
    const live = data?.recordVersions ?? []
    if (!includeArchived) return live
    const archived = (archivedQ.data ?? []).filter((i) => i.archivedAt != null)
    return [...live, ...archived]
  }, [data?.recordVersions, includeArchived, archivedQ.data])

  // Optimistic overrides applied to the state itself, so bucketing stays pure.
  const effective = useMemo(
    () =>
      recordVersions.map((i) =>
        pending[i.id] !== undefined
          ? { ...i, state: { ...i.state, [widget.groupBy]: pending[i.id] || null } }
          : i,
      ),
    [recordVersions, pending, widget.groupBy],
  )

  const buckets = useMemo(
    () => kanbanBuckets(effective, widget.conditions, widget.groupBy, { match: widget.match, me }),
    [effective, widget.conditions, widget.groupBy, widget.match, me],
  )

  // Card body lines: the explicit pick, else the first two scalar fields that
  // aren't the column field or the title's (first text) field.
  const cardFields = useMemo(() => {
    if (widget.cardFields && widget.cardFields.length > 0) {
      return widget.cardFields.map((id) => fields.find((f) => f.id === id)).filter((f) => !!f)
    }
    const titleField = fields.find((f) => f.kind === "text")
    return fields
      .filter(
        (f) =>
          f.kind !== "relation" &&
          f.kind !== "file" &&
          f.id !== widget.groupBy &&
          f.id !== titleField?.id,
      )
      .slice(0, 2)
  }, [fields, widget.cardFields, widget.groupBy])

  if (!widget.conceptId) return <p className="text-sm text-muted-foreground">Pick a concept.</p>
  if (groupField?.kind !== "enum") {
    return (
      <p className="text-sm text-muted-foreground">
        Pick an enum field to group by in the widget settings.
      </p>
    )
  }

  const options = groupField.config.options ?? []
  // Visible subset (in its configured order), tolerating values that no longer
  // exist on the field; an empty/fully-stale selection falls back to all.
  const chosen = (widget.columns ?? []).filter((v) => options.includes(v))
  const colValues = chosen.length > 0 ? chosen : options
  const showEmpty = widget.showEmptyColumns ?? true

  const cardsOf = (key: string): RecordVersion[] => {
    const cards = buckets.get(key) ?? []
    if (!widget.orderBy) return cards
    const k = widget.orderBy
    return [...cards].sort((a, b) => showValue(a.state[k]).localeCompare(showValue(b.state[k])))
  }

  const noValueCards = cardsOf("")
  const columns: Array<{ value: string; cards: RecordVersion[] }> = [
    // The synthetic clear-target only earns space when something sits in it.
    ...(noValueCards.length > 0 ? [{ value: "", cards: noValueCards }] : []),
    ...colValues
      .map((value) => ({ value, cards: cardsOf(value) }))
      .filter((c) => showEmpty || c.cards.length > 0),
  ]

  const activeInst = activeId ? effective.find((i) => i.id === activeId) : undefined

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))

  const onDragEnd = async (e: DragEndEvent) => {
    setActiveId(null)
    suppressClick.current = true
    setTimeout(() => {
      suppressClick.current = false
    }, 0)
    if (!e.over) return
    const instId = String(e.active.id)
    const target = colValue(String(e.over.id))
    // Resolve against the RAW record version — its version is the concurrency token.
    const inst = recordVersions.find((i) => i.id === instId)
    if (!inst) return
    const v = inst.state[widget.groupBy]
    const current = Array.isArray(v) ? String(v[0] ?? "") : v == null ? "" : String(v)
    if (current === target) return
    setPending((p) => ({ ...p, [instId]: target }))
    setMoveError(null)
    try {
      await api.updateRecord(inst.id, inst.version, { [widget.groupBy]: target || null })
    } catch (err) {
      setMoveError(moveErrorText(err))
    } finally {
      await recordsByConcept(conceptId).utils.refetch()
      if (includeArchived) archivedQ.refetch()
      setPending((p) => {
        const { [instId]: _, ...rest } = p
        return rest
      })
    }
  }

  const openCard = (id: string) => {
    if (suppressClick.current) return
    navigate(recordHref(id, { dashboard: widget.recordDashboardId }))
  }

  return (
    // cancel-drag: in the edit modal the tile itself is draggable — card and
    // board interactions must never start a tile drag.
    <div className="cancel-drag flex h-full flex-col">
      {moveError && (
        <p className="shrink-0 truncate pb-1 text-xs text-destructive" title={moveError}>
          {moveError}
        </p>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto pb-1">
          {columns.map(({ value, cards }) => (
            <KanbanColumn
              key={value || "__none"}
              uid={colUid(value)}
              label={value ? capitalize(value) : `No ${groupField.name.toLowerCase()}`}
              color={value ? (groupField.config.optionColors?.[value] ?? null) : null}
              count={cards.length}
              droppable={dragToUpdate}
            >
              {cards.map((inst) => (
                <KanbanCard
                  key={inst.id}
                  inst={inst}
                  title={recordLabel(inst, fields, concept?.titleFieldId)}
                  cardFields={cardFields}
                  // Archived rows are frozen server-side — don't offer the drag.
                  draggable={dragToUpdate && inst.archivedAt == null}
                  onOpen={() => openCard(inst.id)}
                />
              ))}
            </KanbanColumn>
          ))}
          {columns.length === 0 && (
            <p className="self-center text-sm text-muted-foreground">No columns to show.</p>
          )}
        </div>
        {/* Portaled: the edit modal's centering transform would offset a fixed ghost. */}
        {createPortal(
          <DragOverlay>
            {activeInst ? (
              <CardBody
                title={recordLabel(activeInst, fields, concept?.titleFieldId)}
                inst={activeInst}
                cardFields={cardFields}
                ghost
              />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </div>
  )
}

function KanbanColumn({
  uid,
  label,
  color,
  count,
  droppable,
  children,
}: {
  uid: string
  label: string
  color: string | null
  count: number
  droppable: boolean
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: uid, disabled: !droppable })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-56 shrink-0 flex-col rounded-lg border border-transparent bg-muted/40",
        isOver && "border-ring",
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5">
        <LabelChip color={color}>{label}</LabelChip>
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-1.5 pt-0">{children}</div>
    </div>
  )
}

function KanbanCard({
  inst,
  title,
  cardFields,
  draggable,
  onOpen,
}: {
  inst: RecordVersion
  title: string
  cardFields: readonly Field[]
  draggable: boolean
  onOpen: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: inst.id,
    disabled: !draggable,
  })
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dnd-kit's `attributes` spread supplies role="button" + tabIndex
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={cn("cursor-pointer", draggable && "touch-none", isDragging && "opacity-40")}
    >
      <CardBody title={title} inst={inst} cardFields={cardFields} />
    </div>
  )
}

/** One card's face — also the drag-overlay ghost. */
function CardBody({
  title,
  inst,
  cardFields,
  ghost,
}: {
  title: string
  inst: RecordVersion
  cardFields: readonly Field[]
  ghost?: boolean
}) {
  const archived = inst.archivedAt != null
  const rows = cardFields.filter((f) => !isEmptyValue(f, inst.state[f.id]))
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-card p-2 shadow-xs",
        ghost && "w-52 shadow-md",
        archived && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
        {archived && <Badge tone="amber">Archived</Badge>}
      </div>
      {rows.map((f) => (
        <div key={f.id} className="mt-1 truncate text-xs text-muted-foreground">
          <FieldValueCell field={f} value={inst.state[f.id]} />
        </div>
      ))}
    </div>
  )
}
