import { useMutation, useQueryClient } from "@tanstack/react-query"
import { LayoutDashboard, Plus, SlidersHorizontal, Trash2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { IconPicker } from "@/components/IconPicker"
import { usePageChrome } from "@/components/Layout"
import { useFillHeight } from "@/components/MeasuredGrid"
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
  addWidget,
  applyLayouts,
  newWidget,
  referencedConceptIds,
  removeWidget,
  updateWidget,
} from "@/lib/dashboards"
import { useUnsavedGuard } from "@/lib/useUnsavedGuard"
import { WidgetCanvas } from "./WidgetCanvas"
import { WidgetEditor } from "./WidgetEditor"
import { WidgetGallery } from "./WidgetGallery"

/** True for the optimistic-concurrency RpcError (code DASHBOARD_CONFLICT). The
 *  client surfaces RPC failures as a wrapped error, so match code/message/text. */
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
  body: Dashboard["body"]
}

const LIST = "/settings/dashboards"

// The widget inspector is resizable; its width is clamped and remembered.
const INSPECTOR_MIN = 280
const INSPECTOR_MAX = 560
const INSPECTOR_KEY = "dashboard.inspectorWidth"
const clampInspector = (w: number) => Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, w))

/**
 * THE editing surface for a dashboard — a full-page two-tab editor that takes
 * over the settings content area, opened from Settings → Dashboards (the
 * dashboard pages are read-only). General: name, icon, scope, visibility,
 * delete. Layout: add/arrange/configure widgets on a live-data canvas, with the
 * widget config as a side panel. Everything edits a local draft; one Save
 * persists meta + body together (etag-checked against the dashboard as it was
 * when the editor opened), Cancel/back returns to the list (a discard confirm
 * fires on any navigation away while dirty). Delete is the only immediate action.
 */
export function DashboardEditor({
  dash,
  canDelete,
  concepts,
  cIndex,
  conceptsLoaded,
}: {
  dash: Dashboard
  /** False for the last org-shared dashboard — it keeps the home non-empty. */
  canDelete: boolean
  concepts: readonly Concept[]
  cIndex: Map<string, Concept>
  conceptsLoaded: boolean
}) {
  usePageChrome({ fullWidth: true, fillHeight: true })
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const qc = useQueryClient()
  // The dashboard as it was when the editor opened — the etag baseline that Save
  // checks against and that "Restore" reverts to.
  const baseline = (): Draft => ({
    name: dash.name,
    icon: dash.icon,
    scope: dash.ownerId ? "personal" : "org",
    hidden: dash.hidden,
    body: dash.body,
  })
  const [draft, setDraft] = useState<Draft>(baseline)
  const [dirty, setDirty] = useState(false)
  // The active tab lives in the URL (`?tab=layout`) so it's deep-linkable (e.g.
  // the dashboard page's gear) and survives reloads. `replace` keeps tab toggles
  // out of history — back should leave the editor, not cycle tabs.
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
  // Inspector width — restored from the last drag, clamped to the allowed range.
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = Number(localStorage.getItem(INSPECTOR_KEY))
    return saved >= INSPECTOR_MIN && saved <= INSPECTOR_MAX ? saved : 360
  })
  const { blocker, bypass } = useUnsavedGuard(dirty)
  // The canvas is an expandable surface: it fills the box's height so tiles can
  // be placed across the whole area, not just a content-sized strip at the top.
  const { ref: canvasBoxRef, height: canvasHeight } = useFillHeight()
  // Esc deselects the configured widget (clicking empty canvas does too) — but
  // not while the gallery is open, where Esc should just close it.
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
  // Body edits go through a function of the CURRENT draft so rapid interactions
  // (drag stop + remove in one beat) never fold onto a stale body.
  const patchBody = (fn: (body: Dashboard["body"]) => Dashboard["body"]) => {
    setDraft((d) => ({ ...d, body: fn(d.body) }))
    setDirty(true)
  }
  // Throw away every local edit and clear dirty — a no-op when clean, so the
  // button is disabled then.
  const restore = () => {
    setDraft(baseline())
    setDirty(false)
  }

  // Selection toggles on a click. RGL reports the press (onDragStart) and the
  // release (onDragStop) separately, so we remember whether the tile was already
  // selected at press time: a no-move click on the selected tile deselects it,
  // while dragging it (or pressing another tile) keeps it selected — no flicker.
  const press = useRef<{ id: string; wasSelected: boolean } | null>(null)
  const onTilePress = (id: string) => {
    press.current = { id, wasSelected: id === editingId }
    if (id !== editingId) setEditingId(id)
  }
  const onTileStop = (layout: Parameters<typeof applyLayouts>[1]) => {
    // RGL fires stop even for a no-move click; applyLayouts returns the same ref
    // then, so a clean click commits nothing and instead toggles selection.
    if (applyLayouts(draft.body, layout) !== draft.body) patchBody((b) => applyLayouts(b, layout))
    else if (press.current?.wasSelected) setEditingId(null)
    press.current = null
  }

  // Drag the divider to resize the inspector — the panel sits on the right, so
  // dragging left widens it. Width persists for next time on release.
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

  // The draft body's live data — the modal mounts its own collections, so a
  // widget pointed at a not-yet-loaded concept previews before saving.
  const ids = useMemo(() => referencedConceptIds(draft.body), [draft.body])
  const { instData, loaders } = useConceptData(ids)

  const save = useMutation({
    mutationFn: () =>
      api.updateDashboard({
        id: dash.id,
        name: draft.name.trim(),
        icon: draft.icon,
        scope: draft.scope,
        hidden: draft.hidden,
        body: draft.body,
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

  const addOfType = (type: DashboardWidget["type"]) => {
    const w = newWidget(draft.body, type)
    patchBody((b) => addWidget(b, w))
    setEditingId(w.id) // open the config panel immediately to pick a concept
  }

  const editing = draft.body.widgets.find((w) => w.id === editingId) ?? null
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
                  <Button size="sm" variant="outline" onClick={() => setGalleryOpen(true)}>
                    <Plus size={14} /> Add widget
                  </Button>
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
              <Field label="Name">
                <div className="flex items-center gap-2">
                  <IconPicker value={draft.icon} onChange={(icon) => patch({ icon })} />
                  <Input
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="Dashboard name…"
                    className="flex-1"
                  />
                </div>
              </Field>

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
            {/* One frame around the whole working area: a seamless canvas (no
                inner card — widgets sit on the surface) on the left, and the
                widget inspector on the right, divided only by its left border. */}
            <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
              {/* Clicking empty canvas (anything that isn't a tile) deselects;
                  Esc does too. Tile selection rides RGL's onDragStart. */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: background-deselect is a pointer affordance — keyboard users press Esc. */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: same — Esc is handled globally above. */}
              <div
                ref={canvasBoxRef}
                onClick={(e) => {
                  if (editingId && !(e.target as HTMLElement).closest(".react-grid-item"))
                    setEditingId(null)
                }}
                className="flex min-w-0 flex-1 flex-col overflow-y-auto p-3"
              >
                {draft.body.widgets.length === 0 ? (
                  <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
                    <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <LayoutDashboard size={20} />
                    </div>
                    <p className="max-w-sm text-sm text-balance text-muted-foreground">
                      Add a metric or list to start.
                    </p>
                  </div>
                ) : (
                  <WidgetCanvas
                    body={draft.body}
                    instData={instData}
                    cIndex={cIndex}
                    conceptsLoaded={conceptsLoaded}
                    minHeight={canvasHeight}
                    selectedId={editingId}
                    onStop={onTileStop}
                    onSelect={onTilePress}
                  />
                )}
              </div>
              {/* Drag the divider to resize the inspector; arrow keys nudge it. */}
              {/* biome-ignore lint/a11y/useSemanticElements: a focusable, value-bearing window splitter is a div with role=separator, not an <hr>. */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize widget settings"
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
              {/* The inspector is always present — it edits the selected tile,
                  or prompts you to pick one when nothing is selected. */}
              <aside
                style={{ width: inspectorWidth }}
                className="flex shrink-0 flex-col overflow-y-auto p-4"
              >
                {editing ? (
                  <WidgetEditor
                    widget={editing}
                    concepts={concepts}
                    onChange={(p) => patchBody((b) => updateWidget(b, editing.id, p))}
                    onRemove={() => {
                      patchBody((b) => removeWidget(b, editing.id))
                      setEditingId(null)
                    }}
                  />
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <SlidersHorizontal size={18} />
                    </div>
                    <p className="text-sm font-medium text-foreground">No widget selected</p>
                    <p className="max-w-[220px] text-xs text-balance text-muted-foreground">
                      Select a widget on the canvas to configure it.
                    </p>
                  </div>
                )}
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
        <WidgetGallery onPick={(t) => addOfType(t)} onClose={() => setGalleryOpen(false)} />
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
    </div>
  )
}
