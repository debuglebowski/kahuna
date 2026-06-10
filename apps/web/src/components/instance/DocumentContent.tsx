import { useEffect, useRef, useState } from "react"
import { api, type Field } from "../../lib/api"
import { isRichTextValue, type RichTextValue } from "../../lib/richtext"
import { RichTextEditor } from "../editor/RichTextEditor"
import type { InstanceCtx } from "./types"

type SaveStatus = "idle" | "dirty" | "saving" | "error"

const isVersionConflict = (e: unknown): boolean => {
  const err = e as { code?: string; message?: string }
  return err?.code === "VERSION_CONFLICT" || (err?.message?.includes("VersionConflict") ?? false)
}

/**
 * Debounced single-field autosave against `updateInstance`'s optimistic
 * concurrency. The chained version is kept monotonic from the live collection
 * (other tiles' saves bump it via refetch), saves are serialized through a
 * promise chain (never two in flight), and a version conflict refreshes the
 * version and retries once — the patch touches only this field, so a same-field
 * collision is plain last-writer-wins.
 */
function useFieldAutosave(ctx: InstanceCtx, fieldId: string) {
  const [status, setStatus] = useState<SaveStatus>("idle")
  const [error, setError] = useState<string | null>(null)

  const versionRef = useRef(ctx.instance.version)
  versionRef.current = Math.max(versionRef.current, ctx.instance.version)

  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const pendingRef = useRef<RichTextValue | null>(null)
  const timerRef = useRef<number | null>(null)
  const chainRef = useRef<Promise<void>>(Promise.resolve())

  const flushRef = useRef(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    chainRef.current = chainRef.current.then(async () => {
      const value = pendingRef.current
      if (value === null) return
      pendingRef.current = null
      setStatus("saving")
      const save = () =>
        api.updateInstance(ctxRef.current.instance.id, versionRef.current, { [fieldId]: value })
      try {
        let res: Awaited<ReturnType<typeof save>>
        try {
          res = await save()
        } catch (e) {
          if (!isVersionConflict(e)) throw e
          const fresh = await api.getInstance(ctxRef.current.instance.id)
          versionRef.current = Math.max(versionRef.current, fresh.instance.version)
          res = await save()
        }
        versionRef.current = Math.max(versionRef.current, res.version)
        setError(null)
        // Newer keystrokes may have landed while saving — stay dirty for them.
        setStatus(pendingRef.current === null ? "idle" : "dirty")
        ctxRef.current.refetch()
      } catch (e) {
        setStatus("error")
        setError((e as { message?: string })?.message ?? "Save failed")
      }
    })
  })

  const onChange = (v: RichTextValue) => {
    if (!ctxRef.current.editable) return
    pendingRef.current = v
    setStatus((s) => (s === "saving" ? s : "dirty"))
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(flushRef.current, 1500)
  }

  // Unmount: push whatever is pending (fire-and-forget; blur usually beat us).
  useEffect(() => () => flushRef.current(), [])

  return { onChange, onBlur: () => flushRef.current(), status, error }
}

const STATUS_TEXT: Record<SaveStatus, string | null> = {
  idle: null,
  dirty: "Unsaved",
  saving: "Saving…",
  error: null, // the error message renders instead
}

function RichTextField({ ctx, field }: { ctx: InstanceCtx; field: Field }) {
  const { onChange, onBlur, status, error } = useFieldAutosave(ctx, field.id)
  const value = ctx.instance.state[field.id]
  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
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
      />
      {!ctx.editable && !isRichTextValue(value) && (
        <p className="text-xs text-muted-foreground">No content.</p>
      )}
    </section>
  )
}

/** Document tile: every rich text field as a full-width editor (autosaved). */
export function DocumentBody({ ctx }: { ctx: InstanceCtx }) {
  const richFields = ctx.fields.filter((f) => f.kind === "richtext")
  return (
    <div className="space-y-4 p-6">
      {richFields.map((f) => (
        <RichTextField key={f.id} ctx={ctx} field={f} />
      ))}
    </div>
  )
}
