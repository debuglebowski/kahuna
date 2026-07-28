import { useEffect, useRef, useState } from "react"
import { api, type Field } from "../../lib/api"
import { type AutosaveStatus, createAutosave } from "../../lib/autosave"
import { isRichTextValue, type RichTextValue } from "../../lib/richtext"
import { RichTextEditor } from "../editor/RichTextEditor"
import type { InstanceCtx } from "./types"

const isVersionConflict = (e: unknown): boolean => {
  const err = e as { code?: string; message?: string }
  return err?.code === "VERSION_CONFLICT" || (err?.message?.includes("VersionConflict") ?? false)
}

/** Autosave for one richtext field. The save policy (debounce, serialized
 *  saves, one conflict retry) lives in `lib/autosave.ts`; this wires it to
 *  `updateInstance` + the live collection. The chained version is kept
 *  monotonic from ctx, so other tiles' saves (Labels etc.) self-heal it via
 *  refetch. */
function useFieldAutosave(ctx: InstanceCtx, fieldId: string) {
  const [ui, setUi] = useState<{ status: AutosaveStatus; error: string | null }>({
    status: "idle",
    error: null,
  })
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const [autosave] = useState(() =>
    createAutosave<RichTextValue>({
      save: async (value, expectedVersion) => {
        const res = await api.updateInstance(ctxRef.current.instance.id, expectedVersion, {
          [fieldId]: value,
        })
        ctxRef.current.refetch()
        return res.version
      },
      fetchVersion: async () =>
        (await api.getInstance(ctxRef.current.instance.id)).instance.version,
      isConflict: isVersionConflict,
      onStatus: (status, error) => setUi({ status, error }),
    }),
  )
  autosave.bumpVersion(ctx.instance.version)
  // Unmount: push whatever is pending (fire-and-forget; blur usually beat us).
  useEffect(() => () => void autosave.flush(), [autosave])

  return {
    onChange: (v: RichTextValue) => {
      if (ctxRef.current.editable) autosave.change(v)
    },
    onBlur: () => void autosave.flush(),
    status: ui.status,
    error: ui.error,
  }
}

const STATUS_TEXT: Record<AutosaveStatus, string | null> = {
  idle: null,
  dirty: "Unsaved",
  saving: "Saving…",
  error: null, // the error message renders instead
}

function RichTextField({ ctx, field }: { ctx: InstanceCtx; field: Field }) {
  const { onChange, onBlur, status, error } = useFieldAutosave(ctx, field.id)
  const value = ctx.instance.state[field.id]
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex shrink-0 items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{field.name}</span>
        {status === "error" ? (
          <span className="text-xs text-destructive">{error ?? "Save failed"}</span>
        ) : (
          STATUS_TEXT[status] && (
            <span className="text-xs text-muted-foreground">{STATUS_TEXT[status]}</span>
          )
        )}
      </div>
      <RichTextEditor
        value={value}
        editable={ctx.editable}
        placeholder={`Write ${field.name.toLowerCase()}…`}
        onChange={onChange}
        onBlur={onBlur}
        fill
      />
      {!ctx.editable && !isRichTextValue(value) && (
        <p className="text-xs text-muted-foreground">No content.</p>
      )}
    </section>
  )
}

/** Document tile: every rich text field as a full-width editor (autosaved),
 *  stretched over the tile's height (several fields split it evenly; each editor
 *  scrolls its own content when a doc outgrows its share). */
export function DocumentBody({ ctx }: { ctx: InstanceCtx }) {
  const richFields = ctx.fields.filter((f) => f.kind === "richtext")
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      {richFields.map((f) => (
        <RichTextField key={f.id} ctx={ctx} field={f} />
      ))}
    </div>
  )
}
