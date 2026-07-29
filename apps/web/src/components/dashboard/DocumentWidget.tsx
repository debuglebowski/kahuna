import { useMutation, useQuery } from "@tanstack/react-query"
import { FileText, GitBranch, Lock, RefreshCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { api, type DashboardWidget } from "@/lib/api"
import { type AutosaveStatus, createAutosave } from "@/lib/autosave"
import { canEditVersion } from "@/lib/editability"
import { recordHref } from "@/lib/recordHref"
import { isRichTextValue, type RichTextValue } from "@/lib/richtext"
import { useFields } from "../ConditionList"
import { RichTextEditor } from "../editor/RichTextEditor"
import { Button, Spinner } from "../ui"

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

/** A connector kind ("linear", "google.gmail") as a source name ("Linear", "Gmail"). */
const sourceLabel = (managedBy: string): string => {
  const seg = managedBy.split(".").pop() ?? managedBy
  return seg.charAt(0).toUpperCase() + seg.slice(1)
}

/** The save indicator that shares the editor's toolbar row (editable only). */
function SaveStatus({ status, error }: { status: AutosaveStatus; error: string | null }) {
  if (status === "error")
    return <span className="text-xs text-destructive">{error ?? "Save failed"}</span>
  const text = STATUS_TEXT[status]
  if (!text) return null
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {status === "dirty" && <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />}
      {text}
    </span>
  )
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
 * uses. The tile always renders its full editing chrome (toolbar + framed
 * surface) so it looks identical in the layout editor and on the live page;
 * `interactive` (the canvas's render-vs-arrange flag) only governs whether
 * keystrokes land — while tiles are being arranged it's inert. Synced (managed)
 * fields and frozen published versions stay read-only either way, and say so in a
 * footer banner under the content.
 */
export function DocumentWidget({ widget, interactive }: { widget: Doc; interactive: boolean }) {
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
      interactive={interactive}
    />
  )
}

function DocumentEditor({
  instanceId,
  fieldId,
  interactive,
}: {
  instanceId: string
  fieldId: string
  interactive: boolean
}) {
  const navigate = useNavigate()
  const instanceQ = useQuery({
    queryKey: ["instanceItem", instanceId],
    queryFn: () => api.getInstance(instanceId),
    retry: false,
  })
  const inst = instanceQ.data?.instance
  const fieldsQ = useFields(inst?.conceptId ?? "")
  const field = fieldsQ.data?.find((f) => f.id === fieldId)
  const conceptsQ = useQuery({ queryKey: ["concepts"], queryFn: () => api.listConcepts() })
  const concept = conceptsQ.data?.find((c) => c.id === inst?.conceptId)

  // A frozen version would reject every save (VersionFrozen), so the widget renders
  // read-only with a jump to the draft instead. A published version on a concept
  // that allows amendments is NOT frozen — it saves in place, so no strip.
  const frozen = !!inst && !canEditVersion(concept, inst)
  const itemId = inst?.itemId
  // Only the frozen strip offers the draft jump, so only it needs the version list.
  const versionsQ = useQuery({
    queryKey: ["versions", itemId],
    queryFn: () => api.listVersions(itemId as string),
    enabled: frozen && !!itemId,
  })
  const openDraft = versionsQ.data?.find((v) => v.versionStatus === "draft" && !v.archivedAt)
  const newVersion = useMutation({
    mutationFn: () => api.newVersion(itemId as string),
    onSuccess: (d) => navigate(recordHref(d.id)),
  })

  const autosave = useDocAutosave(instanceId, fieldId, () => void instanceQ.refetch())
  // Keep the autosave's chained version in step with the server (also pre-arms
  // the very first save so it doesn't waste its conflict retry on a stale 0).
  const version = inst?.version
  useEffect(() => {
    if (version != null) autosave.bumpVersion(version)
  }, [version, autosave.bumpVersion])

  if (instanceQ.isLoading || fieldsQ.isLoading || conceptsQ.isLoading || !inst) return <Spinner />
  if (instanceQ.error)
    return <p className="text-sm text-muted-foreground">Record unavailable — pick another.</p>
  if (!field)
    return <p className="text-sm text-muted-foreground">Field unavailable — pick another.</p>
  if (field.kind !== "richtext")
    return <p className="text-sm text-muted-foreground">“{field.name}” isn’t a rich text field.</p>

  // A writable rich-text surface: shows the editing chrome (toolbar + framed
  // box) regardless of `interactive`, so the layout editor and the live page look
  // the same. Synced (managed) fields and frozen published versions aren't
  // writable — they get a footer banner instead. `canType` (writable + an
  // interactive canvas) is the only thing that lets keystrokes land.
  const managed = field.managedBy != null
  const writable = !managed && !frozen
  const canType = writable && interactive
  const value = inst.state[fieldId]
  const empty = !isRichTextValue(value)

  const goToDraft = () => (openDraft ? navigate(recordHref(openDraft.id)) : newVersion.mutate())

  return (
    <div className="flex h-full flex-col gap-1.5">
      {/* Flex column so the editor's `fill` has a height to stretch over; it
          scrolls its own content, so no scroll container here. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {!writable && empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center text-muted-foreground">
            <FileText size={20} className="opacity-55" />
            <span className="text-xs">Nothing written yet</span>
          </div>
        ) : (
          <RichTextEditor
            value={value}
            editable={canType}
            chrome={writable}
            placeholder="Write…"
            onChange={autosave.onChange}
            onBlur={autosave.onBlur}
            fill
            toolbarRight={
              writable ? <SaveStatus status={autosave.status} error={autosave.error} /> : undefined
            }
          />
        )}
      </div>

      {/* Read-only status banner, pinned under the content — a full-width bar,
          only when the reason is worth stating (synced or frozen). A writable
          surface has no banner; it surfaces its status in the toolbar instead. */}
      {managed ? (
        <div className="flex shrink-0 items-center gap-1.5 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <RefreshCw size={13} className="shrink-0" />
          Synced from {sourceLabel(field.managedBy as string)} · read-only
        </div>
      ) : frozen ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <Lock size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">Published version · read-only</span>
          {/* Errors sit in the banner so it stays the one place the state is explained. */}
          {newVersion.error && (
            <span className="text-destructive">{(newVersion.error as Error).message}</span>
          )}
          <Button size="xs" variant="outline" onClick={goToDraft} disabled={newVersion.isPending}>
            <GitBranch />
            {openDraft ? "Open draft" : newVersion.isPending ? "Creating…" : "New draft"}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
