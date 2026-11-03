import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "../ui"

/**
 * Floating "You have unsaved changes · Discard · Save changes" bar for the
 * graph canvases (same look as the permissions SaveBar). Renders nothing while
 * clean — it appears the moment there is something to save. The canvases share
 * a layout org-wide, so edits are local until saved here. Place it in a React
 * Flow `<Panel position="bottom-center">` so it belongs to its canvas.
 */
export function GraphSaveBar({
  dirty,
  saving,
  error,
  onSave,
  onDiscard,
}: {
  dirty: boolean
  saving: boolean
  error: boolean
  onSave: () => void
  onDiscard: () => void
}) {
  if (!dirty) return null
  return (
    // `shadow-lift` inverts with the palette, so the bar stays distinct from the
    // canvas in dark mode too.
    <div className="flex animate-in items-center gap-3 rounded-xl border bg-popover px-4 py-2.5 text-popover-foreground shadow-lift duration-200 fade-in slide-in-from-bottom-2">
      <span className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {error ? "Save failed — try again" : "You have unsaved changes"}
      </span>
      <Button size="sm" variant="outline" disabled={saving} onClick={onDiscard}>
        Discard
      </Button>
      <Button size="sm" disabled={saving} onClick={onSave}>
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </div>
  )
}

/** Confirm shown when navigation is blocked by unsaved graph edits. */
export function GraphLeaveConfirm({
  blocked,
  onLeave,
  onStay,
}: {
  blocked: boolean
  onLeave: () => void
  onStay: () => void
}) {
  if (!blocked) return null
  return (
    <ConfirmDialog
      title="Discard layout changes?"
      message="Your changes to this graph haven't been saved."
      confirmLabel="Discard"
      confirmVariant="danger"
      onConfirm={onLeave}
      onCancel={onStay}
    />
  )
}
