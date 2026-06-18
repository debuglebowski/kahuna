import { useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { api, type DashboardWidget } from "@/lib/api"
import { type AutosaveStatus, createAutosave } from "@/lib/autosave"
import { isRichTextValue, type RichTextValue } from "@/lib/richtext"
import { useFields } from "../ConditionList"
import { RichTextEditor } from "../editor/RichTextEditor"
import { Spinner } from "../ui"

type Doc = Extract<DashboardWidget, { type: "document" }>

const isVersionConflict = (e: unknown): boolean => {
  const err = e as { code?: string; message?: string }
  return err?.code === "VERSION_CONFLICT" || (err?.message?.includes("VersionConflict") ?? false)
}

const STATUS_TEXT: Record<AutosaveStatus, string | null> = {
  idle: null,
  dirty: "Unsaved",
  saving: "Saving…",
  error: null, // the error message renders instead
}

/** Autosave for one record's richtext field — the same policy the Document
 *  instance-tile uses (`lib/autosave.ts`: debounce, serialized saves, one
 *  conflict retry), wired to `updateInstance` + a refetch. The chained version
 *  is kept monotonic from the live query so a write landing elsewhere self-heals. */
function useDocAutosave(instanceId: string, fieldId: string, refetch: () => void) {
  const [ui, setUi] = useState<{ status: AutosaveStatus; error: string | null }>({
    status: "idle",
    error: null,
  })
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch
  const [autosave] = useState(() =>
    createAutosave<RichTextValue>({
      save: async (value, expectedVersion) => {
        const res = await api.updateInstance(instanceId, expectedVersion, { [fieldId]: value })
        refetchRef.current()
        return res.version
      },
      fetchVersion: async () => (await api.getInstance(instanceId)).instance.version,
      isConflict: isVersionConflict,
      onStatus: (status, error) => setUi({ status, error }),
    }),
  )
  // Unmount: push whatever is pending (fire-and-forget; blur usually beat us).
  useEffect(() => () => void autosave.flush(), [autosave])
  return {
    onChange: (v: RichTextValue) => autosave.change(v),
    onBlur: () => void autosave.flush(),
    bumpVersion: autosave.bumpVersion,
    status: ui.status,
    error: ui.error,
  }
}

/**
 * Document — one record's rich text field, edited inline on the canvas. A
 * dashboard consumer of the same `RichTextEditor` the instance Document tile
 * uses; `editable` follows the canvas's read-only flag, so it's live on the
 * dashboard (and the editor's Preview) but inert while tiles are being arranged.
 * Synced (managed) fields stay read-only regardless.
 */
export function DocumentWidget({ widget, editable }: { widget: Doc; editable: boolean }) {
  if (!widget.instanceId || !widget.fieldId)
    return (
      <p className="text-sm text-muted-foreground">
        Pick a record and a rich text field in the widget settings.
      </p>
    )
  // Key on the target so re-picking a record/field in the editor remounts the
  // autosave (its save closure captures the ids once).
  return (
    <DocumentEditor
      key={`${widget.instanceId}:${widget.fieldId}`}
      instanceId={widget.instanceId}
      fieldId={widget.fieldId}
      hideLabel={widget.hideLabel ?? false}
      editable={editable}
    />
  )
}

function DocumentEditor({
  instanceId,
  fieldId,
  hideLabel,
  editable,
}: {
  instanceId: string
  fieldId: string
  hideLabel: boolean
  editable: boolean
}) {
  const instanceQ = useQuery({
    queryKey: ["instanceItem", instanceId],
    queryFn: () => api.getInstance(instanceId),
    retry: false,
  })
  const inst = instanceQ.data?.instance
  const fieldsQ = useFields(inst?.conceptId ?? "")
  const field = fieldsQ.data?.find((f) => f.id === fieldId)

  const autosave = useDocAutosave(instanceId, fieldId, () => void instanceQ.refetch())
  // Keep the autosave's chained version in step with the server (also pre-arms
  // the very first save so it doesn't waste its conflict retry on a stale 0).
  const version = inst?.version
  useEffect(() => {
    if (version != null) autosave.bumpVersion(version)
  }, [version, autosave.bumpVersion])

  if (instanceQ.isLoading || fieldsQ.isLoading) return <Spinner />
  if (instanceQ.error)
    return <p className="text-sm text-muted-foreground">Record unavailable — pick another.</p>
  if (!field)
    return <p className="text-sm text-muted-foreground">Field unavailable — pick another.</p>
  if (field.kind !== "richtext")
    return <p className="text-sm text-muted-foreground">“{field.name}” isn’t a rich text field.</p>

  // Synced fields are read-only (updateInstance would 403); show the editor inert.
  const managed = field.managedBy != null
  const canEdit = editable && !managed
  const value = inst?.state[fieldId]

  return (
    <div className="flex h-full flex-col gap-1.5">
      {!hideLabel && (
        <div className="flex shrink-0 items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">{field.name}</span>
          {autosave.status === "error" ? (
            <span className="text-xs text-destructive">{autosave.error ?? "Save failed"}</span>
          ) : managed ? (
            <span className="text-xs text-muted-foreground">Synced — read-only</span>
          ) : (
            STATUS_TEXT[autosave.status] && (
              <span className="text-xs text-muted-foreground">{STATUS_TEXT[autosave.status]}</span>
            )
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RichTextEditor
          value={value}
          editable={canEdit}
          placeholder={`Write ${field.name.toLowerCase()}…`}
          onChange={autosave.onChange}
          onBlur={autosave.onBlur}
          fill
        />
      </div>
      {!canEdit && !isRichTextValue(value) && (
        <p className="shrink-0 text-xs text-muted-foreground">No content.</p>
      )}
    </div>
  )
}
