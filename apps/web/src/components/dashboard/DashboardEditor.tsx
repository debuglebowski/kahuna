import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  ChevronUp,
  Group as GroupIcon,
  LayoutDashboard,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react"
import { type DragEvent as ReactDragEvent, useEffect, useMemo, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { IconPicker } from "@/components/IconPicker"
import { usePageChrome } from "@/components/Layout"
import { Button, ConfirmDialog, Field, Input, TabBar, TabBarItem } from "@/components/ui"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { api, type Concept, type Dashboard, type DashboardWidget } from "@/lib/api"
import { useConceptData } from "@/lib/conceptData"
import {
  findNode,
  insertNode,
  isGroup,
  migrate,
  moveNode,
  type NormBody,
  type NormGroup,
  type NormNode,
  type NormWidget,
  newGroup,
  newWidget,
  parentOf,
  referencedConceptIds,
  removeNode,
  reorderNode,
  retypeWidget,
  serialize,
  subtreeIds,
  unwrapGroup,
  updateNode,
} from "@/lib/dashboards"
import { useUnsavedGuard } from "@/lib/useUnsavedGuard"
import { cn } from "@/lib/utils"
import { WidgetCanvas } from "./WidgetCanvas"
import { SizeControls, WidgetEditor } from "./WidgetEditor"
import { WidgetGallery } from "./WidgetGallery"

/** True for the optimistic-concurrency RpcError (code DASHBOARD_CONFLICT). */
const isConflictError = (e: unknown): boolean => {
  const o = e as { code?: unknown; message?: unknown } | null
  const s = `${o?.code ?? ""} ${o?.message ?? ""} ${String(e)}`
  return s.includes("DASHBOARD_CONFLICT") || s.includes("DashboardConflict")
}

interface Draft {
  name: string
  icon: string | null
  scope: "personal" | "org"
  hidden: boolean
  body: NormBody
}

const LIST = "/settings/dashboards"

const INSPECTOR_MIN = 300
const INSPECTOR_MAX = 600
const INSPECTOR_KEY = "dashboard.inspectorWidth"
const clampInspector = (w: number) => Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, w))

const nodeLabel = (n: NormNode, cIndex: Map<string, Concept>): string => {
  if (isGroup(n)) return `${n.direction === "row" ? "Row" : "Column"} group`
  return (
    n.title ||
    ("conceptId" in n && n.conceptId ? (cIndex.get(n.conceptId)?.name ?? "") : "") ||
    n.type
  )
}

type DropZone = "before" | "after" | "into"

/** Drag-and-drop state + actions shared across the (recursive) Layers tree. */
interface LayersDnd {
  dragId: string | null
  hint: { id: string; zone: DropZone } | null
  /** True if `parentId` is the dragged node or inside its subtree (illegal target). */
  invalid: (parentId: string | null) => boolean
  start: (id: string) => void
  end: () => void
  over: (id: string, zone: DropZone) => void
  /** Commit: move the dragged node into `parentId` before `beforeId` (null = append). */
  drop: (parentId: string | null, beforeId: string | null) => void
}

/** The structure tree — select / reorder / delete / DRAG any node, nested. Drag a
 *  row onto a group's middle to nest it; onto a row's top/bottom edge to place it
 *  before/after (same parent) — so you can pull things in and out of groups. */
function Layers({
  nodes,
  depth,
  parentId,
  selectedId,
  cIndex,
  dnd,
  onSelect,
  onReorder,
  onRemove,
}: {
  nodes: NormNode[]
  depth: number
  parentId: string | null
  selectedId: string | null
  cIndex: Map<string, Concept>
  dnd: LayersDnd
  onSelect: (id: string) => void
  onReorder: (id: string, delta: number) => void
  onRemove: (id: string) => void
}) {
  return (
    <>
      {nodes.map((n, i) => {
        const nextId = nodes[i + 1]?.id ?? null
        const grp = isGroup(n)
        // Where a drop at `zone` would land, and whether it's legal.
        const target = (zone: DropZone): { parent: string | null; before: string | null } =>
          zone === "into"
            ? { parent: n.id, before: null }
            : zone === "before"
              ? { parent: parentId, before: n.id }
              : { parent: parentId, before: nextId }
        const canDrop = (zone: DropZone) =>
          dnd.dragId !== null && dnd.dragId !== n.id && !dnd.invalid(target(zone).parent)
        const zoneAt = (e: ReactDragEvent): DropZone => {
          const r = e.currentTarget.getBoundingClientRect()
          const f = (e.clientY - r.top) / Math.max(1, r.height)
          if (grp) return f < 0.33 ? "before" : f > 0.67 ? "after" : "into"
          return f < 0.5 ? "before" : "after"
        }
        const hint = dnd.hint?.id === n.id ? dnd.hint.zone : null
        return (
          <div key={n.id}>
            {/* biome-ignore lint/a11y/useSemanticElements: a row can't be a <button> — it holds its own action buttons (nested buttons are invalid). */}
            <div
              role="button"
              tabIndex={0}
              draggable
              onDragStart={(e) => {
                e.stopPropagation()
                e.dataTransfer.effectAllowed = "move"
                e.dataTransfer.setData("text/plain", n.id)
                dnd.start(n.id)
              }}
              onDragEnd={dnd.end}
              onDragOver={(e) => {
                const zone = zoneAt(e)
                if (!canDrop(zone)) return
                e.preventDefault()
                e.stopPropagation()
                dnd.over(n.id, zone)
              }}
              onDrop={(e) => {
                const zone = zoneAt(e)
                if (!canDrop(zone)) return
                e.preventDefault()
                e.stopPropagation()
                const t = target(zone)
                dnd.drop(t.parent, t.before)
              }}
              onClick={() => onSelect(n.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onSelect(n.id)
                }
              }}
              style={{ paddingLeft: 6 + depth * 12 }}
              className={cn(
                "relative flex cursor-grab items-center gap-1 rounded py-1 pr-1 text-xs hover:bg-accent",
                selectedId === n.id && "bg-accent",
                hint === "into" && "bg-primary/15 ring-1 ring-primary",
                dnd.dragId === n.id && "opacity-40",
              )}
            >
              {hint === "before" && (
                <div className="absolute inset-x-0 top-0 h-0.5 rounded bg-primary" />
              )}
              {hint === "after" && (
                <div className="absolute inset-x-0 bottom-0 h-0.5 rounded bg-primary" />
              )}
              {grp && <GroupIcon size={12} className="shrink-0 text-muted-foreground" />}
              <span className={cn("flex-1 truncate", grp && "text-muted-foreground")}>
                {nodeLabel(n, cIndex)}
              </span>
              <button
                type="button"
                aria-label="Move up"
                className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  onReorder(n.id, -1)
                }}
              >
                <ChevronUp size={13} />
              </button>
              <button
                type="button"
                aria-label="Move down"
                className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  onReorder(n.id, 1)
                }}
              >
                <ChevronDown size={13} />
              </button>
              <button
                type="button"
                aria-label="Delete"
                className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(n.id)
                }}
              >
                <X size={13} />
              </button>
            </div>
            {grp && (
              <Layers
                nodes={n.children}
                depth={depth + 1}
                parentId={n.id}
                selectedId={selectedId}
                cIndex={cIndex}
                dnd={dnd}
                onSelect={onSelect}
                onReorder={onReorder}
                onRemove={onRemove}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

/** Reparent control — move a node into any other group, or the root window.
 *  Hidden when there's nowhere else to go (no other groups). */
function MoveControl({
  nodeId,
  body,
  cIndex,
  onMove,
}: {
  nodeId: string
  body: NormBody
  cIndex: Map<string, Concept>
  onMove: (target: string | null) => void
}) {
  const node = findNode(body, nodeId)
  const excluded = new Set(node ? subtreeIds(node) : [])
  const options: { value: string; label: string }[] = [{ value: "__root", label: "Root (window)" }]
  const walk = (nodes: NormNode[], depth: number) => {
    for (const n of nodes) {
      if (!isGroup(n)) continue
      if (!excluded.has(n.id))
        options.push({ value: n.id, label: `${"— ".repeat(depth)}${nodeLabel(n, cIndex)}` })
      walk(n.children, depth + 1)
    }
  }
  walk(body.children, 0)
  if (options.length <= 1) return null
  const value = parentOf(body, nodeId) ?? "__root"
  return (
    <Field
      label="Move to"
      hint="Reparent this node into another group, or back to the root window."
    >
      <Select value={value} onValueChange={(v) => onMove(v === "__root" ? null : v)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function GroupInspector({
  group,
  onChange,
  onUnwrap,
  onRemove,
}: {
  group: NormGroup
  onChange: (patch: Partial<NormGroup>) => void
  onUnwrap: () => void
  onRemove: () => void
}) {
  return (
    <div className="space-y-4">
      <Field
        label="Direction"
        hint="How this group flows its children. fr children share this axis."
      >
        <Select
          value={group.direction}
          onValueChange={(v) => onChange({ direction: v as "row" | "col" })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="row">Row → (horizontal)</SelectItem>
            <SelectItem value="col">Column ↓ (vertical)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <SizeControls node={group} onChange={onChange} />
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <Button variant="outline" onClick={onUnwrap} disabled={group.children.length === 0}>
          Unwrap — keep contents
        </Button>
        <Button variant="destructive" onClick={onRemove}>
          <Trash2 size={15} /> Delete group{group.children.length > 0 ? " + contents" : ""}
        </Button>
      </div>
    </div>
  )
}

/**
 * THE editing surface for a dashboard — a full-page two-tab editor. General:
 * name, icon, scope, visibility, delete. Layout: build the auto-layout tree
 * (groups + widgets) on a live preview, with a layers panel and a per-node config
 * panel. Everything edits a local draft; one Save persists meta + body together.
 */
export function DashboardEditor({
  dash,
  canDelete,
  concepts,
  cIndex,
  conceptsLoaded,
}: {
  dash: Dashboard
  canDelete: boolean
  concepts: readonly Concept[]
  cIndex: Map<string, Concept>
  conceptsLoaded: boolean
}) {
  usePageChrome({ fullWidth: true, fillHeight: true })
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const qc = useQueryClient()
  const baseline = (): Draft => ({
    name: dash.name,
    icon: dash.icon,
    scope: dash.ownerId ? "personal" : "org",
    hidden: dash.hidden,
    // Normalize the stored body (tree or legacy flat list) into the runtime tree.
    body: migrate(dash.body),
  })
  const [draft, setDraft] = useState<Draft>(baseline)
  const [dirty, setDirty] = useState(false)
  const tab = searchParams.get("tab") === "layout" ? "layout" : "general"
  const setTab = (next: string) =>
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        p.set("tab", next)
        return p
      },
      { replace: true },
    )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Deleting a non-empty group takes its contents with it — confirm first.
  const [confirmNodeDelete, setConfirmNodeDelete] = useState<string | null>(null)
  // Layers drag-and-drop: the dragged row + the current drop hint.
  const [layerDrag, setLayerDrag] = useState<string | null>(null)
  const [layerHint, setLayerHint] = useState<{ id: string; zone: DropZone } | null>(null)
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = Number(localStorage.getItem(INSPECTOR_KEY))
    return saved >= INSPECTOR_MIN && saved <= INSPECTOR_MAX ? saved : 380
  })
  const { blocker, bypass } = useUnsavedGuard(dirty)

  useEffect(() => {
    if (!editingId || galleryOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditingId(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [editingId, galleryOpen])

  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }))
    setDirty(true)
  }
  const patchBody = (fn: (body: NormBody) => NormBody) => {
    setDraft((d) => ({ ...d, body: fn(d.body) }))
    setDirty(true)
  }
  const restore = () => {
    setDraft(baseline())
    setDirty(false)
  }

  const startInspectorResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = inspectorWidth
    let last = startW
    const onMove = (ev: PointerEvent) => {
      last = clampInspector(startW + (startX - ev.clientX))
      setInspectorWidth(last)
    }
    const onUp = () => {
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
      document.body.style.removeProperty("cursor")
      document.body.style.removeProperty("user-select")
      localStorage.setItem(INSPECTOR_KEY, String(last))
    }
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
  }

  const ids = useMemo(() => referencedConceptIds(draft.body), [draft.body])
  const { instData, loaders } = useConceptData(ids)

  const editing = editingId ? findNode(draft.body, editingId) : null
  // New nodes drop into the selected group, else the root.
  const targetParent = editing && isGroup(editing) ? editing.id : null

  const save = useMutation({
    mutationFn: () =>
      api.updateDashboard({
        id: dash.id,
        name: draft.name.trim(),
        icon: draft.icon,
        scope: draft.scope,
        hidden: draft.hidden,
        body: serialize(draft.body),
        expectedUpdatedAt: dash.updatedAt ?? undefined,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["dashboards"] })
      bypass()
      navigate(LIST)
    },
  })
  const del = useMutation({
    mutationFn: () => api.deleteDashboard(dash.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["dashboards"] })
      bypass()
      navigate(LIST)
    },
  })

  const addWidgetOfType = (type: DashboardWidget["type"]) => {
    const node = newWidget(type)
    patchBody((b) => insertNode(b, targetParent, node))
    setEditingId(node.id)
    setGalleryOpen(false)
  }
  const addGroup = () => {
    const g = newGroup("row")
    patchBody((b) => insertNode(b, targetParent, g))
    setEditingId(g.id)
  }
  const removeSelected = (id: string) => {
    patchBody((b) => removeNode(b, id))
    if (id === editingId) setEditingId(null)
  }
  // Delete immediately, but confirm when it would take a group's contents with it.
  const requestRemove = (id: string) => {
    const n = findNode(draft.body, id)
    if (n && isGroup(n) && n.children.length > 0) setConfirmNodeDelete(id)
    else removeSelected(id)
  }

  // Drag-and-drop wiring for the Layers tree (reparent + reorder via moveNode).
  const draggedSubtree = useMemo(() => {
    if (!layerDrag) return null
    const n = findNode(draft.body, layerDrag)
    return n ? new Set(subtreeIds(n)) : null
  }, [layerDrag, draft.body])
  const layersDnd: LayersDnd = {
    dragId: layerDrag,
    hint: layerHint,
    invalid: (parent) => parent !== null && (draggedSubtree?.has(parent) ?? false),
    start: setLayerDrag,
    end: () => {
      setLayerDrag(null)
      setLayerHint(null)
    },
    over: (id, zone) => setLayerHint({ id, zone }),
    drop: (parent, before) => {
      if (layerDrag) patchBody((b) => moveNode(b, layerDrag, parent, before))
      setLayerDrag(null)
      setLayerHint(null)
    },
  }

  const saveError = save.error
    ? isConflictError(save.error)
      ? "This dashboard was changed elsewhere — close without saving and reopen to edit the latest."
      : (save.error as Error).message
    : null

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 pb-3 text-base font-medium text-foreground">
        <button
          type="button"
          onClick={() => navigate(LIST)}
          className="truncate text-muted-foreground hover:text-foreground"
        >
          Dashboards
        </button>
        <span className="text-muted-foreground/50">/</span>
        <span className="truncate">{draft.name.trim() || "Untitled dashboard"}</span>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {loaders}
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
          <TabBar
            right={
              <>
                {tab === "layout" && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setGalleryOpen(true)}>
                      <Plus size={14} /> Add widget
                    </Button>
                    <Button size="sm" variant="outline" onClick={addGroup}>
                      <GroupIcon size={14} /> Add group
                    </Button>
                  </>
                )}
                <Button size="sm" variant="outline" onClick={restore} disabled={!dirty}>
                  Restore
                </Button>
                <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </>
            }
          >
            <TabBarItem value="general" icon={<SlidersHorizontal size={16} />}>
              General
            </TabBarItem>
            <TabBarItem value="layout" icon={<LayoutDashboard size={16} />}>
              Layout
            </TabBarItem>
          </TabBar>

          <TabsContent value="general" className="min-h-0 flex-1 overflow-y-auto pt-4 pb-6">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Field label="Name" className="flex-1">
                  <Input
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="Dashboard name…"
                  />
                </Field>
                <Field label="Icon">
                  <IconPicker value={draft.icon} onChange={(icon) => patch({ icon })} />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Scope">
                  <Select
                    value={draft.scope}
                    onValueChange={(v) => patch({ scope: v as "personal" | "org" })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">Personal (only me)</SelectItem>
                      <SelectItem value="org">Org (everyone)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Visibility">
                  <Select
                    value={draft.hidden ? "hidden" : "shown"}
                    onValueChange={(v) => patch({ hidden: v === "hidden" })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="shown">Shown in switcher</SelectItem>
                      <SelectItem value="hidden">Hidden</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <div className="border-t border-border pt-3">
                <Button
                  variant="destructive"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={del.isPending || !canDelete}
                  title={canDelete ? undefined : "The last shared dashboard can't be deleted."}
                >
                  <Trash2 size={15} /> Delete dashboard
                </Button>
                {!canDelete && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    This is the last shared dashboard — it can't be deleted.
                  </p>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="layout" className="flex min-h-0 flex-1 pt-4">
            <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
              {/* The live preview. Clicking empty space (outside any tile/group)
                  deselects — node clicks stop propagation. */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: background-deselect affordance; Esc also deselects. */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc handled globally. */}
              <div
                onClick={() => setEditingId(null)}
                className="min-w-0 flex-1 overflow-hidden bg-muted/20 p-3"
              >
                {draft.body.children.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
                    <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <LayoutDashboard size={20} />
                    </div>
                    <p className="max-w-sm text-sm text-balance text-muted-foreground">
                      Add a widget or a group to start building the layout.
                    </p>
                  </div>
                ) : (
                  <WidgetCanvas
                    body={draft.body}
                    instData={instData}
                    cIndex={cIndex}
                    conceptsLoaded={conceptsLoaded}
                    selectedId={editingId}
                    onSelect={setEditingId}
                    onMove={(id, target, before) =>
                      patchBody((b) => moveNode(b, id, target, before))
                    }
                  />
                )}
              </div>
              {/* biome-ignore lint/a11y/useSemanticElements: a value-bearing splitter is a div with role=separator. */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize inspector"
                aria-valuenow={inspectorWidth}
                aria-valuemin={INSPECTOR_MIN}
                aria-valuemax={INSPECTOR_MAX}
                tabIndex={0}
                onPointerDown={startInspectorResize}
                onKeyDown={(e) => {
                  const delta = e.key === "ArrowLeft" ? 16 : e.key === "ArrowRight" ? -16 : 0
                  if (!delta) return
                  e.preventDefault()
                  const next = clampInspector(inspectorWidth + delta)
                  setInspectorWidth(next)
                  localStorage.setItem(INSPECTOR_KEY, String(next))
                }}
                className="relative w-px shrink-0 cursor-col-resize bg-border outline-none transition-colors after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-[''] hover:bg-primary/40 focus-visible:bg-primary/60"
              />
              <aside
                style={{ width: inspectorWidth }}
                className="flex shrink-0 flex-col overflow-hidden"
              >
                {/* Layers — the structure tree. */}
                <div className="min-h-[120px] max-h-[40%] shrink-0 overflow-y-auto border-b border-border p-2">
                  <p className="px-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    Layers
                  </p>
                  {draft.body.children.length === 0 ? (
                    <p className="px-1.5 text-xs text-muted-foreground">Nothing yet.</p>
                  ) : (
                    <Layers
                      nodes={draft.body.children}
                      depth={0}
                      parentId={null}
                      selectedId={editingId}
                      cIndex={cIndex}
                      dnd={layersDnd}
                      onSelect={setEditingId}
                      onReorder={(id, delta) => patchBody((b) => reorderNode(b, id, delta))}
                      onRemove={requestRemove}
                    />
                  )}
                </div>
                {/* Selected-node settings. */}
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  {editing == null ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                      <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <SlidersHorizontal size={18} />
                      </div>
                      <p className="text-sm font-medium text-foreground">Nothing selected</p>
                      <p className="max-w-[220px] text-xs text-balance text-muted-foreground">
                        Select a widget or group — on the canvas or in Layers — to configure it. New
                        items drop into the selected group.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <MoveControl
                        nodeId={editing.id}
                        body={draft.body}
                        cIndex={cIndex}
                        onMove={(target) => patchBody((b) => moveNode(b, editing.id, target))}
                      />
                      {isGroup(editing) ? (
                        <GroupInspector
                          group={editing}
                          onChange={(p) =>
                            patchBody((b) =>
                              updateNode(b, editing.id, (n) => ({ ...n, ...p }) as NormNode),
                            )
                          }
                          onUnwrap={() => {
                            patchBody((b) => unwrapGroup(b, editing.id))
                            setEditingId(null)
                          }}
                          onRemove={() => requestRemove(editing.id)}
                        />
                      ) : (
                        <WidgetEditor
                          widget={editing}
                          concepts={concepts}
                          onChange={(p) =>
                            patchBody((b) =>
                              updateNode(b, editing.id, (n) => ({ ...n, ...p }) as NormNode),
                            )
                          }
                          onChangeType={(type) =>
                            patchBody((b) =>
                              updateNode(b, editing.id, () =>
                                retypeWidget(editing as NormWidget, type),
                              ),
                            )
                          }
                          onRemove={() => removeSelected(editing.id)}
                        />
                      )}
                    </div>
                  )}
                </div>
              </aside>
            </div>
          </TabsContent>
        </Tabs>

        {saveError && (
          <div className="pointer-events-none absolute right-6 bottom-6 z-10">
            <p className="pointer-events-auto max-w-md rounded-md border border-destructive/30 bg-background px-3 py-2 text-xs text-destructive shadow-lg">
              {saveError}
            </p>
          </div>
        )}
      </div>

      {galleryOpen && (
        <WidgetGallery onPick={(t) => addWidgetOfType(t)} onClose={() => setGalleryOpen(false)} />
      )}
      {blocker.state === "blocked" && (
        <ConfirmDialog
          title="Discard changes?"
          message="Your edits to this dashboard haven't been saved."
          confirmLabel="Discard"
          confirmVariant="danger"
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        />
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title="Delete dashboard?"
          message={`"${draft.name.trim() || dash.name}" and its layout will be permanently deleted.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          pending={del.isPending}
          error={del.error ? (del.error as Error).message : undefined}
          onConfirm={() => del.mutate()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
      {confirmNodeDelete && (
        <ConfirmDialog
          title="Delete this group?"
          message="The group and everything inside it will be removed. To keep the contents, use “Unwrap” instead."
          confirmLabel="Delete group + contents"
          confirmVariant="danger"
          onConfirm={() => {
            removeSelected(confirmNodeDelete)
            setConfirmNodeDelete(null)
          }}
          onCancel={() => setConfirmNodeDelete(null)}
        />
      )}
    </div>
  )
}
