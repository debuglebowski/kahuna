import { useMutation, useQueryClient } from "@tanstack/react-query"
import { LayoutDashboard, Plus, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { IconPicker } from "@/components/IconPicker"
import { Button, ConfirmDialog, Field, Input } from "@/components/ui"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { WidgetCanvas } from "./WidgetCanvas"
import { WidgetEditor } from "./WidgetEditor"

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

/**
 * THE editing surface for a dashboard — a large two-tab modal, opened from
 * Settings → Dashboards (the dashboard pages are read-only). General: name,
 * icon, scope, visibility, delete. Layout: add/arrange/configure widgets on a
 * live-data canvas, with the widget config as a side panel. Everything edits a
 * local draft; one Save persists meta + body together (etag-checked against
 * the dashboard as it was when the modal opened), Cancel discards (confirmed
 * when dirty). Delete is the only immediate action.
 */
export function DashboardModal({
  dash,
  canDelete,
  concepts,
  cIndex,
  conceptsLoaded,
  onClose,
  onDeleted,
}: {
  dash: Dashboard
  /** False for the last org-shared dashboard — it keeps the home non-empty. */
  canDelete: boolean
  concepts: readonly Concept[]
  cIndex: Map<string, Concept>
  conceptsLoaded: boolean
  onClose: () => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Draft>(() => ({
    name: dash.name,
    icon: dash.icon,
    scope: dash.ownerId ? "personal" : "org",
    hidden: dash.hidden,
    body: dash.body,
  }))
  const [dirty, setDirty] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

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
      onClose()
    },
  })
  const del = useMutation({
    mutationFn: () => api.deleteDashboard(dash.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["dashboards"] })
      onDeleted()
    },
  })

  const requestClose = () => (dirty ? setConfirmingClose(true) : onClose())

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
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[88vh] w-[min(1280px,96vw)] flex-col gap-0 p-0 sm:max-w-none"
      >
        {loaders}
        <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col gap-0">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3">
            <div className="flex min-w-0 items-center gap-4">
              <DialogTitle className="truncate text-base">
                {draft.name.trim() || "Edit dashboard"}
              </DialogTitle>
              <TabsList>
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="layout">Layout</TabsTrigger>
              </TabsList>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {saveError && <p className="max-w-md text-xs text-destructive">{saveError}</p>}
              <Button variant="outline" onClick={requestClose}>
                Cancel
              </Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </header>

          <TabsContent value="general" className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="max-w-lg space-y-4">
              <div className="flex items-end gap-2">
                <IconPicker value={draft.icon} onChange={(icon) => patch({ icon })} />
                <div className="flex-1">
                  <Field label="Name">
                    <Input
                      value={draft.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      placeholder="Dashboard name…"
                    />
                  </Field>
                </div>
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

          <TabsContent value="layout" className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-5 py-2.5">
              <Select value="" onValueChange={(t) => addOfType(t as DashboardWidget["type"])}>
                <SelectTrigger className="cancel-drag" size="sm">
                  <Plus size={14} />
                  <SelectValue placeholder="Add widget" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="metric">Metric</SelectItem>
                  <SelectItem value="list">List / Table</SelectItem>
                  <SelectItem value="breakdown">Breakdown</SelectItem>
                  <SelectItem value="attention">Attention</SelectItem>
                  <SelectItem value="trend">Trend</SelectItem>
                  <SelectItem value="activity">Activity</SelectItem>
                  <SelectItem value="tasks">Tasks</SelectItem>
                  <SelectItem value="members">Members</SelectItem>
                  <SelectItem value="welcome">Welcome</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Drag to move, pull a corner to resize — saved when you hit Save.
              </p>
            </div>

            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1 overflow-y-auto p-4">
                {draft.body.widgets.length === 0 ? (
                  <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-xl border border-dashed p-12 text-center">
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
                    onStop={(layout) => patchBody((b) => applyLayouts(b, layout))}
                    onEdit={setEditingId}
                    onRemove={(id) => {
                      patchBody((b) => removeWidget(b, id))
                      if (id === editingId) setEditingId(null)
                    }}
                  />
                )}
              </div>
              {editing && (
                <aside className="w-[360px] shrink-0 overflow-y-auto border-l p-4">
                  <WidgetEditor
                    widget={editing}
                    concepts={concepts}
                    onChange={(p) => patchBody((b) => updateWidget(b, editing.id, p))}
                    onClose={() => setEditingId(null)}
                  />
                </aside>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>

      {confirmingClose && (
        <ConfirmDialog
          title="Discard changes?"
          message="Your edits to this dashboard haven't been saved."
          confirmLabel="Discard"
          confirmVariant="danger"
          onConfirm={onClose}
          onCancel={() => setConfirmingClose(false)}
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
    </Dialog>
  )
}
