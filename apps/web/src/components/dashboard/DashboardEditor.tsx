import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  Eye,
  Group as GroupIcon,
  LayoutDashboard,
  Plus,
  SlidersHorizontal,
  SquareStack,
  Trash2,
  X,
} from "lucide-react"
import { type DragEvent as ReactDragEvent, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { ConceptSelectItems } from "@/components/ConceptSelectItems"
import { IconPicker } from "@/components/IconPicker"
import { usePageChrome } from "@/components/Layout"
import { Button, ConfirmDialog, Field, Input, TabBar, TabBarItem } from "@/components/ui"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  isTabs,
  migrate,
  moveNode,
  type NormBody,
  type NormGroup,
  type NormNode,
  type NormWidget,
  newGroup,
  newTabs,
  newWidget,
  referencedConceptIds,
  removeNode,
  reorderNode,
  retypeWidget,
  serialize,
  subtreeIds,
  unwrapGroup,
  updateNode,
} from "@/lib/dashboards"
import { instanceLabel } from "@/lib/instanceLabel"
import { useInstanceCtx } from "@/lib/useInstanceCtx"
import { useUnsavedGuard } from "@/lib/useUnsavedGuard"
import { cn } from "@/lib/utils"
import { InspectorSection } from "./InspectorSection"
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
const INSPECTOR_DEFAULT = 380
const INSPECTOR_KEY = "dashboard.inspectorWidth"
const clampInspector = (w: number) => Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, w))

// Layers vs Settings split (fraction of the inspector's height taken by Layers).
const LAYERS_MIN_FRAC = 0.15
const LAYERS_MAX_FRAC = 0.7
const LAYERS_DEFAULT_FRAC = 1 / 4
const LAYERS_KEY = "dashboard.layersFraction"
const clampLayers = (f: number) => Math.min(LAYERS_MAX_FRAC, Math.max(LAYERS_MIN_FRAC, f))

const nodeLabel = (n: NormNode, cIndex: Map<string, Concept>): string => {
  if (isGroup(n)) {
    if (n.display === "tabs") return n.label || "Tabs"
    return n.label || `${n.direction === "row" ? "Row" : "Column"} group`
  }
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
              {grp ? (
                isTabs(n) ? (
                  <SquareStack size={12} className="shrink-0 text-muted-foreground" />
                ) : (
                  <GroupIcon size={12} className="shrink-0 text-muted-foreground" />
                )
              ) : (
                <span className="flex w-3 shrink-0 justify-center" aria-hidden="true">
                  <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                </span>
              )}
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

/** Flow ↔ tabs picker, shared by both group inspectors. */
function DisplayField({
  group,
  onChange,
}: {
  group: NormGroup
  onChange: (patch: Partial<NormGroup>) => void
}) {
  return (
    <Field
      label="Display"
      hint="Flow lays children out along the direction; tabs show one at a time behind a tab bar."
    >
      <Select
        value={group.display === "tabs" ? "tabs" : "flow"}
        onValueChange={(v) => onChange({ display: v as "flow" | "tabs" })}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="flow">Flow (all visible)</SelectItem>
          <SelectItem value="tabs">Tabs (one at a time)</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  )
}

function GroupInspector({
  group,
  onChange,
  onUnwrap,
}: {
  group: NormGroup
  onChange: (patch: Partial<NormGroup>) => void
  onUnwrap: () => void
}) {
  return (
    <div className="divide-y divide-border">
      <InspectorSection title="Size">
        <SizeControls node={group} onChange={onChange} />
      </InspectorSection>
      <InspectorSection title="General">
        <Field
          label="Label"
          hint="Name shown in Layers (and as the tab title inside a tabs group)."
        >
          <Input
            value={group.label ?? ""}
            onChange={(e) => onChange({ label: e.target.value || null })}
            placeholder={`${group.direction === "row" ? "Row" : "Column"} group`}
          />
        </Field>
        <DisplayField group={group} onChange={onChange} />
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
      </InspectorSection>
      <div className="pt-3">
        <Button
          variant="outline"
          className="w-full"
          onClick={onUnwrap}
          disabled={group.children.length === 0}
        >
          Unwrap — keep contents
        </Button>
      </div>
    </div>
  )
}

/** Inspector for a tabs group — display + bar position, plus the tab list
 *  (rename / set-default / reorder / remove). Tabs are CREATED by dragging a node
 *  onto the tab bar (the dropped node is the tab); this panel manages the ones
 *  that exist. */
function TabsInspector({
  group,
  onChange,
  onTabRename,
  onTabRemove,
  onTabReorder,
  onSetDefault,
  onUnwrap,
}: {
  group: NormGroup
  onChange: (patch: Partial<NormGroup>) => void
  onTabRename: (childId: string, label: string) => void
  onTabRemove: (childId: string) => void
  onTabReorder: (childId: string, delta: number) => void
  onSetDefault: (childId: string) => void
  onUnwrap: () => void
}) {
  const defaultId =
    group.active && group.children.some((c) => c.id === group.active)
      ? group.active
      : (group.children[0]?.id ?? null)
  return (
    <div className="divide-y divide-border">
      <InspectorSection title="Size">
        <SizeControls node={group} onChange={onChange} />
      </InspectorSection>
      <InspectorSection title="General">
        <Field label="Label" hint="Name shown in Layers.">
          <Input
            value={group.label ?? ""}
            onChange={(e) => onChange({ label: e.target.value || null })}
            placeholder="Tabs"
          />
        </Field>
        <DisplayField group={group} onChange={onChange} />
        <Field label="Tab bar" hint="Which edge the tabs sit on.">
          <Select
            value={group.tabBar ?? "top"}
            onValueChange={(v) => onChange({ tabBar: v as "top" | "bottom" | "left" | "right" })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="top">Top</SelectItem>
              <SelectItem value="bottom">Bottom</SelectItem>
              <SelectItem value="left">Left</SelectItem>
              <SelectItem value="right">Right</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </InspectorSection>

      <InspectorSection title="Tabs">
        {group.children.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No tabs yet — drag a widget or group onto the tab bar to add one.
          </p>
        ) : (
          <div className="space-y-1">
            {group.children.map((c, i) => (
              <div key={c.id} className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={c.id === defaultId ? "Default tab" : "Set as default tab"}
                  title={c.id === defaultId ? "Opens by default" : "Set as default tab"}
                  onClick={() => onSetDefault(c.id)}
                  className={cn(
                    "shrink-0 rounded p-0.5",
                    c.id === defaultId
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c.id === defaultId ? <CircleDot size={14} /> : <Circle size={14} />}
                </button>
                <Input
                  value={(isGroup(c) ? c.label : c.title) ?? ""}
                  placeholder={`Tab ${i + 1}`}
                  onChange={(e) => onTabRename(c.id, e.target.value)}
                  className="h-8 flex-1"
                />
                <button
                  type="button"
                  aria-label="Move up"
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => onTabReorder(c.id, -1)}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => onTabReorder(c.id, 1)}
                >
                  <ChevronDown size={14} />
                </button>
                <button
                  type="button"
                  aria-label="Remove tab"
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                  onClick={() => onTabRemove(c.id)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </InspectorSection>

      <div className="pt-3">
        <Button
          variant="outline"
          className="w-full"
          onClick={onUnwrap}
          disabled={group.children.length === 0}
        >
          Unwrap — keep contents
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
  recordMode = false,
  recordConceptId = null,
}: {
  dash: Dashboard
  canDelete: boolean
  concepts: readonly Concept[]
  cIndex: Map<string, Concept>
  conceptsLoaded: boolean
  /** Record dashboard: gate the palette to record widgets + supply a sample-record
   *  preview, and drop scope/visibility (a record view is a shared per-concept
   *  template). Otherwise the editor is identical to a page dashboard's. */
  recordMode?: boolean
  /** The owning concept (record mode) — drives the preview-record picker. */
  recordConceptId?: string | null
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
  // Last-saved snapshot (the Restore target) + its optimistic-concurrency token.
  // Saving stays in the editor and advances both, so repeated saves keep working.
  const [saved, setSaved] = useState<Draft>(baseline)
  const [savedAt, setSavedAt] = useState<Date | null>(dash.updatedAt ?? null)
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
  // Full-screen read-only preview of the draft (how the live dashboard renders).
  const [previewing, setPreviewing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Deleting a non-empty group takes its contents with it — confirm first.
  const [confirmNodeDelete, setConfirmNodeDelete] = useState<string | null>(null)
  // Record mode: the concept the user picked to repoint this view at, pending
  // confirmation (repointing resets the layout — see `changeConcept`).
  const [pendingConcept, setPendingConcept] = useState<string | null>(null)
  // Layers drag-and-drop: the dragged row + the current drop hint.
  const [layerDrag, setLayerDrag] = useState<string | null>(null)
  const [layerHint, setLayerHint] = useState<{ id: string; zone: DropZone } | null>(null)
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = Number(localStorage.getItem(INSPECTOR_KEY))
    return saved >= INSPECTOR_MIN && saved <= INSPECTOR_MAX ? saved : INSPECTOR_DEFAULT
  })
  // Vertical split of the inspector: Settings (top) vs Layers (bottom). Layers
  // defaults to a quarter of the height, Settings the remaining three quarters.
  // The ref is the splittable region (Settings + splitter + Layers), so the
  // fraction math stays exact regardless of the pinned remove footer below it.
  const splitRef = useRef<HTMLDivElement>(null)
  const [layersFraction, setLayersFraction] = useState(() => {
    const saved = Number(localStorage.getItem(LAYERS_KEY))
    return saved >= LAYERS_MIN_FRAC && saved <= LAYERS_MAX_FRAC ? saved : LAYERS_DEFAULT_FRAC
  })
  const { blocker, bypass } = useUnsavedGuard(dirty)

  useEffect(() => {
    if (!editingId || galleryOpen || previewing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditingId(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [editingId, galleryOpen, previewing])

  useEffect(() => {
    if (!previewing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewing(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [previewing])

  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }))
    setDirty(true)
  }
  const patchBody = (fn: (body: NormBody) => NormBody) => {
    setDraft((d) => ({ ...d, body: fn(d.body) }))
    setDirty(true)
  }
  const restore = () => {
    setDraft(saved)
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

  const startLayersResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const rect = splitRef.current?.getBoundingClientRect()
    if (!rect) return
    let last = layersFraction
    const onMove = (ev: PointerEvent) => {
      // Layers sits at the BOTTOM, so its share grows as the pointer rises.
      last = clampLayers(1 - (ev.clientY - rect.top) / Math.max(1, rect.height))
      setLayersFraction(last)
    }
    const onUp = () => {
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
      document.body.style.removeProperty("cursor")
      document.body.style.removeProperty("user-select")
      localStorage.setItem(LAYERS_KEY, String(last))
    }
    document.body.style.cursor = "row-resize"
    document.body.style.userSelect = "none"
    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
  }

  const ids = useMemo(() => {
    const base = referencedConceptIds(draft.body)
    // Record dashboards also load the owning concept (preview-record picker +
    // related-scoped widgets resolve against it).
    return recordMode && recordConceptId && !base.includes(recordConceptId)
      ? [...base, recordConceptId]
      : base
  }, [draft.body, recordMode, recordConceptId])
  const { instData, loaders } = useConceptData(ids)

  // Record dashboards render their widgets against a real sample instance so the
  // preview shows live data. Defaults to the first instance; the picker overrides.
  const sampleInstances = recordConceptId ? (instData[recordConceptId]?.instances ?? []) : []
  const sampleFields = recordConceptId ? (instData[recordConceptId]?.fields ?? []) : []
  const [previewId, setPreviewId] = useState<string | null>(null)
  const effectivePreviewId =
    previewId && sampleInstances.some((i) => i.id === previewId)
      ? previewId
      : (sampleInstances[0]?.id ?? "")

  // For a versioned concept the preview can be rendered against any version of the
  // chosen sample record (not just its head), so the designer can check how the
  // layout behaves for a draft vs a published version. The version picker lists the
  // selected record's lineage; switching just repoints which version row renders.
  const versioned = !!(recordConceptId && cIndex.get(recordConceptId)?.versioningEnabled)
  const previewItemId = sampleInstances.find((i) => i.id === effectivePreviewId)?.itemId ?? null
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null)
  const versionsQ = useQuery({
    queryKey: ["versions", previewItemId],
    queryFn: () => api.listVersions(previewItemId as string),
    enabled: versioned && !!previewItemId,
  })
  const versions = versionsQ.data ?? []
  // Falls back to the selected head whenever the pinned version isn't in this
  // record's lineage (e.g. right after switching the preview record).
  const effectiveVersionId =
    previewVersionId && versions.some((v) => v.id === previewVersionId)
      ? previewVersionId
      : effectivePreviewId
  const { ctx: previewCtx } = useInstanceCtx(recordMode ? effectiveVersionId : "")
  const recordCtx = recordMode ? (previewCtx ?? undefined) : undefined

  const editing = editingId ? findNode(draft.body, editingId) : null
  // New nodes drop into the selected group, else the root.
  const targetParent = editing && isGroup(editing) ? editing.id : null
  // Empty tree → the canvas shows its own prompt and the inspector is hidden.
  const hasNodes = draft.body.children.length > 0

  const save = useMutation({
    mutationFn: (d: Draft) =>
      api.updateDashboard({
        id: dash.id,
        name: d.name.trim(),
        icon: d.icon,
        scope: d.scope,
        hidden: d.hidden,
        body: serialize(d.body),
        expectedUpdatedAt: savedAt ?? undefined,
      }),
    // Save stays in the editor (no navigate): the just-saved draft becomes the new
    // Restore baseline and the returned updatedAt is the next write's token.
    onSuccess: async (updated, d) => {
      await qc.invalidateQueries({ queryKey: ["dashboards"] })
      setSaved(d)
      setSavedAt(updated.updatedAt ?? null)
      setDirty(false)
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
  // Whether repointing the concept would discard widgets: anything bound to a
  // concept (lists, metrics, related-record panels…) references the old schema's
  // fields and can't carry over. A view of only record-scoped widgets survives.
  const conceptBoundWidgets = referencedConceptIds(draft.body).length > 0
  const changeConcept = useMutation({
    mutationFn: (newConceptId: string) =>
      api.updateDashboard({
        id: dash.id,
        conceptId: newConceptId,
        // Wipe the layout only when something is actually bound to the old concept.
        body: conceptBoundWidgets ? { widgets: [] } : serialize(draft.body),
      }),
    onSuccess: async (updated) => {
      await qc.invalidateQueries({ queryKey: ["dashboards"] })
      await qc.invalidateQueries({ queryKey: ["recordDashboards"] })
      setPendingConcept(null)
      // Repoint the URL → the parent remounts the editor with the reset body.
      bypass()
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          if (updated.conceptId) p.set("concept", updated.conceptId)
          return p
        },
        { replace: true },
      )
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
  const addTabs = () => {
    const t = newTabs()
    patchBody((b) => insertNode(b, targetParent, t))
    setEditingId(t.id)
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
  // Saved-and-untouched: the Save button swaps its label for a check.
  const saveConfirmed = !dirty && save.isSuccess

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
        <span className="min-w-0 truncate">{draft.name.trim() || "Untitled dashboard"}</span>
        {/* Record views: which concept this template renders, pinned top-right above
            the tab toolbar. Repointing resets the layout, so it's confirmed. */}
        {recordMode && (
          <div className="ml-auto flex shrink-0 items-center gap-2 text-sm font-normal">
            <span className="text-muted-foreground">Renders for</span>
            <Select
              value={recordConceptId ?? ""}
              onValueChange={(v) => {
                if (v && v !== recordConceptId) setPendingConcept(v)
              }}
            >
              <SelectTrigger className="h-8 max-w-56" title="Concept this view renders">
                <SelectValue placeholder="Concept" />
              </SelectTrigger>
              <SelectContent>
                <ConceptSelectItems concepts={concepts} label={(c) => c.name} />
              </SelectContent>
            </Select>
            {sampleInstances.length > 0 && (
              <>
                <span className="text-muted-foreground">Preview</span>
                <Select
                  value={effectivePreviewId}
                  onValueChange={(v) => {
                    setPreviewId(v)
                    // The pinned version belonged to the previous record — drop it so
                    // the new record previews against its own head.
                    setPreviewVersionId(null)
                  }}
                >
                  <SelectTrigger className="h-8 max-w-56" title="Preview record">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sampleInstances.slice(0, 50).map((inst) => (
                      <SelectItem key={inst.id} value={inst.id}>
                        {instanceLabel(
                          inst,
                          sampleFields,
                          recordConceptId
                            ? (cIndex.get(recordConceptId)?.titleFieldId ?? null)
                            : null,
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {versioned && (
                  <>
                    <span className="text-muted-foreground">Version</span>
                    <Select value={effectiveVersionId} onValueChange={setPreviewVersionId}>
                      <SelectTrigger className="h-8 max-w-40" title="Preview version">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {/* Newest first, matching the Versions panel ordering. */}
                        {[...versions].reverse().map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {v.versionStatus === "draft"
                              ? `Draft v${v.versionSeq}`
                              : `v${v.versionSeq}`}
                            {v.archivedAt ? " (archived)" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {loaders}
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
          <TabBar
            right={
              <>
                {tab === "layout" && (
                  <>
                    {/* Preview toggle (icon-only) sits left of Add; previewing disables
                        Add since the canvas is read-only while it's on. */}
                    <Button
                      size="icon-sm"
                      variant={previewing ? "secondary" : "outline"}
                      onClick={() => setPreviewing((p) => !p)}
                      disabled={!previewing && !hasNodes}
                      aria-pressed={previewing}
                      aria-label={previewing ? "Exit preview" : "Preview"}
                      title={
                        previewing
                          ? "Exit preview"
                          : hasNodes
                            ? "Preview"
                            : "Add a widget to preview the dashboard."
                      }
                    >
                      <Eye size={14} />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="outline" disabled={previewing}>
                          <Plus size={14} /> Add
                          <ChevronDown size={14} className="opacity-60" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-40">
                        <DropdownMenuItem onSelect={() => setGalleryOpen(true)}>
                          <Plus size={14} /> Widget
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={addGroup}>
                          <GroupIcon size={14} /> Group
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={addTabs}>
                          <SquareStack size={14} /> Tabs
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <div className="mx-1.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
                  </>
                )}
                <Button size="sm" variant="outline" onClick={restore} disabled={!dirty}>
                  Restore
                </Button>
                <Button
                  size="sm"
                  className="relative"
                  onClick={() => save.mutate(draft)}
                  disabled={!dirty || save.isPending}
                >
                  {/* Confirming a save swaps the label for a check in place: the label
                      keeps its box (opacity only) and the check is absolute, so the
                      button never changes width and reserves no empty slot. The check
                      is wrapped so it isn't a direct svg child — that would trip the
                      button's has-[>svg] padding rule and shift the width. */}
                  <span className={cn(saveConfirmed && "opacity-0")}>
                    {save.isPending ? "Saving…" : "Save"}
                  </span>
                  {saveConfirmed && (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <Check size={14} />
                    </span>
                  )}
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

              {/* Scope applies to both kinds (personal vs org). Visibility is the
                switcher toggle — page dashboards only; record views aren't in it. */}
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
                {!recordMode && (
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
                )}
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
              {previewing ? (
                // readOnly fills the tab content area with the live look + interactive
                // widgets. Same p-3 as the edit canvas below so toggling doesn't shift it.
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  <WidgetCanvas
                    body={draft.body}
                    instData={instData}
                    cIndex={cIndex}
                    conceptsLoaded={conceptsLoaded}
                    record={recordCtx}
                    readOnly
                  />
                </div>
              ) : (
                <>
                  {/* The live preview. Clicking empty space (outside any tile/group)
                  deselects — node clicks stop propagation. */}
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: background-deselect affordance; Esc also deselects. */}
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc handled globally. */}
                  <div
                    onClick={() => setEditingId(null)}
                    className="min-w-0 flex-1 overflow-hidden bg-muted/20 p-3"
                  >
                    {!hasNodes ? (
                      <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
                        <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <LayoutDashboard size={20} />
                        </div>
                        <p className="max-w-sm text-sm text-balance text-muted-foreground">
                          Add a widget or a group to start building the layout.
                        </p>
                        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation()
                              setGalleryOpen(true)
                            }}
                          >
                            <Plus size={14} /> Add widget
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation()
                              addGroup()
                            }}
                          >
                            <GroupIcon size={14} /> Add group
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => {
                              e.stopPropagation()
                              addTabs()
                            }}
                          >
                            <SquareStack size={14} /> Add tabs
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <WidgetCanvas
                        body={draft.body}
                        instData={instData}
                        cIndex={cIndex}
                        conceptsLoaded={conceptsLoaded}
                        record={recordCtx}
                        selectedId={editingId}
                        onSelect={setEditingId}
                        onMove={(id, target, before) =>
                          patchBody((b) => moveNode(b, id, target, before))
                        }
                      />
                    )}
                  </div>
                  {hasNodes && (
                    <>
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
                        onDoubleClick={() => {
                          setInspectorWidth(INSPECTOR_DEFAULT)
                          localStorage.setItem(INSPECTOR_KEY, String(INSPECTOR_DEFAULT))
                        }}
                        onKeyDown={(e) => {
                          const delta =
                            e.key === "ArrowLeft" ? 16 : e.key === "ArrowRight" ? -16 : 0
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
                        {/* Splittable region: Settings (top), splitter, Layers (bottom). */}
                        <div
                          ref={splitRef}
                          className="flex min-h-0 flex-1 flex-col overflow-hidden"
                        >
                          {/* Selected-node settings. */}
                          <div className="min-h-0 flex-1 overflow-y-auto p-4">
                            {editing == null ? (
                              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                                <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                                  <SlidersHorizontal size={18} />
                                </div>
                                <p className="text-sm font-medium text-foreground">
                                  Nothing selected
                                </p>
                                <p className="max-w-[220px] text-xs text-balance text-muted-foreground">
                                  Select a widget or group — on the canvas or in Layers — to
                                  configure it. New items drop into the selected group.
                                </p>
                              </div>
                            ) : isGroup(editing) ? (
                              editing.display === "tabs" ? (
                                <TabsInspector
                                  group={editing}
                                  onChange={(p) =>
                                    patchBody((b) =>
                                      updateNode(
                                        b,
                                        editing.id,
                                        (n) => ({ ...n, ...p }) as NormNode,
                                      ),
                                    )
                                  }
                                  onTabRename={(childId, label) =>
                                    patchBody((b) =>
                                      updateNode(b, childId, (n) =>
                                        isGroup(n)
                                          ? ({ ...n, label: label || null } as NormNode)
                                          : ({ ...n, title: label || null } as NormNode),
                                      ),
                                    )
                                  }
                                  onTabRemove={(childId) => requestRemove(childId)}
                                  onTabReorder={(childId, delta) =>
                                    patchBody((b) => reorderNode(b, childId, delta))
                                  }
                                  onSetDefault={(childId) =>
                                    patchBody((b) =>
                                      updateNode(
                                        b,
                                        editing.id,
                                        (n) => ({ ...n, active: childId }) as NormNode,
                                      ),
                                    )
                                  }
                                  onUnwrap={() => {
                                    patchBody((b) => unwrapGroup(b, editing.id))
                                    setEditingId(null)
                                  }}
                                />
                              ) : (
                                <GroupInspector
                                  group={editing}
                                  onChange={(p) =>
                                    patchBody((b) =>
                                      updateNode(
                                        b,
                                        editing.id,
                                        (n) => ({ ...n, ...p }) as NormNode,
                                      ),
                                    )
                                  }
                                  onUnwrap={() => {
                                    patchBody((b) => unwrapGroup(b, editing.id))
                                    setEditingId(null)
                                  }}
                                />
                              )
                            ) : (
                              <WidgetEditor
                                widget={editing}
                                concepts={concepts}
                                recordMode={recordMode}
                                recordConceptId={recordConceptId}
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
                              />
                            )}
                          </div>
                          {/* Remove action — pinned to the bottom of the settings pane. */}
                          {editing && (
                            <div className="p-4 pt-0">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  isGroup(editing)
                                    ? requestRemove(editing.id)
                                    : removeSelected(editing.id)
                                }
                                className="w-full justify-center gap-1.5 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 size={14} />
                                {isGroup(editing)
                                  ? `Delete ${editing.display === "tabs" ? "tabs" : "group"}${
                                      editing.children.length > 0 ? " + contents" : ""
                                    }`
                                  : "Remove widget"}
                              </Button>
                            </div>
                          )}
                          {/* biome-ignore lint/a11y/useSemanticElements: a value-bearing splitter is a div with role=separator. */}
                          <div
                            role="separator"
                            aria-orientation="horizontal"
                            aria-label="Resize layers"
                            aria-valuenow={Math.round(layersFraction * 100)}
                            aria-valuemin={Math.round(LAYERS_MIN_FRAC * 100)}
                            aria-valuemax={Math.round(LAYERS_MAX_FRAC * 100)}
                            tabIndex={0}
                            onPointerDown={startLayersResize}
                            onDoubleClick={() => {
                              setLayersFraction(LAYERS_DEFAULT_FRAC)
                              localStorage.setItem(LAYERS_KEY, String(LAYERS_DEFAULT_FRAC))
                            }}
                            onKeyDown={(e) => {
                              // Layers is the bottom pane: ArrowUp grows it, ArrowDown shrinks it.
                              const delta =
                                e.key === "ArrowUp" ? 0.03 : e.key === "ArrowDown" ? -0.03 : 0
                              if (!delta) return
                              e.preventDefault()
                              const next = clampLayers(layersFraction + delta)
                              setLayersFraction(next)
                              localStorage.setItem(LAYERS_KEY, String(next))
                            }}
                            className="relative h-px shrink-0 cursor-row-resize bg-border outline-none transition-colors after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 after:content-[''] hover:bg-primary/40 focus-visible:bg-primary/60"
                          />
                          {/* Layers — the structure tree (resizable; defaults to a quarter). */}
                          <div
                            style={{ height: `${layersFraction * 100}%` }}
                            className="flex min-h-[64px] shrink-0 flex-col overflow-hidden"
                          >
                            <div className="min-h-0 flex-1 overflow-y-auto p-2">
                              <Layers
                                nodes={draft.body.children}
                                depth={0}
                                parentId={null}
                                selectedId={editingId}
                                cIndex={cIndex}
                                dnd={layersDnd}
                                onSelect={setEditingId}
                                onReorder={(id, delta) =>
                                  patchBody((b) => reorderNode(b, id, delta))
                                }
                                onRemove={requestRemove}
                              />
                            </div>
                          </div>
                        </div>
                      </aside>
                    </>
                  )}
                </>
              )}
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
        <WidgetGallery
          onPick={(t) => addWidgetOfType(t)}
          onClose={() => setGalleryOpen(false)}
          kind={recordMode ? "record" : "page"}
        />
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
      {pendingConcept && (
        <ConfirmDialog
          title="Change concept?"
          message={
            conceptBoundWidgets
              ? `This view’s widgets are bound to ${cIndex.get(recordConceptId ?? "")?.name ?? "the current concept"} and can’t carry over. Switching to ${cIndex.get(pendingConcept)?.name ?? "another concept"} will clear the layout so you can rebuild it.`
              : `Switch this view to ${cIndex.get(pendingConcept)?.name ?? "another concept"}? Its current widgets aren’t bound to a concept, so they’ll be kept.`
          }
          confirmLabel="Change concept"
          confirmVariant={conceptBoundWidgets ? "danger" : "primary"}
          pending={changeConcept.isPending}
          error={changeConcept.error ? (changeConcept.error as Error).message : undefined}
          onConfirm={() => changeConcept.mutate(pendingConcept)}
          onCancel={() => setPendingConcept(null)}
        />
      )}
    </div>
  )
}
