import type { MouseEvent } from "react"
import { api } from "../../lib/api"
import { FieldValueCell } from "../../lib/fieldDisplay"
import { showValue } from "../../lib/utils"
import type { SaveCell } from "../InlineCellEditor"
import { DetailFieldEditor } from "./DetailFieldEditor"
import type { RecordVersionCtx } from "./types"

/** Clicking anywhere on a row triggers its editor: text/number/money inputs
 *  take the caret, everything else activates — dropdowns and pickers open,
 *  json/lists expand, bool toggles. Radix Selects open on pointerdown (not
 *  click) while plain buttons and Popover triggers respond to click, so both
 *  are dispatched — each control ignores the one it doesn't handle. */
const forwardRowClick = (e: MouseEvent<HTMLElement>) => {
  // Only skip clicks that land on the control itself (it handles them
  // natively) — the value cell stretches across the row, so its empty space
  // must forward too, not just the label's.
  if ((e.target as HTMLElement).closest("button, input, textarea, a, label")) return
  const dd = e.currentTarget.querySelector("dd")
  const input = dd?.querySelector<HTMLElement>("input, textarea")
  if (input) {
    input.focus()
    return
  }
  const btn = dd?.querySelector<HTMLElement>("button")
  if (!btn) return
  btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }))
  btn.click()
}

/** Field values in declared order, plus any orphaned state keys — field ids
 *  whose def was deleted (engine-internal `__` markers are skipped). When the
 *  record version is editable (non-versioned, or a draft) each value edits inline,
 *  autosaving per field via `updateRecord` — every save is an
 *  `RecordVersionUpdated` event, so it lands in the Activity feed. */
export function DetailsBody({ ctx }: { ctx: RecordVersionCtx }) {
  const { recordVersion, fields, editable, refetch } = ctx
  const declared = new Set(fields.map((f) => f.id))
  const extras = Object.keys(recordVersion.state).filter(
    (k) => !declared.has(k) && !k.startsWith("__"),
  )
  // One field per save; refetch (success or fail) reconciles value + version.
  const saveCell: SaveCell = async (inst, fieldId, value) => {
    try {
      await api.updateRecord(inst.id, inst.version, { [fieldId]: value })
    } finally {
      refetch()
    }
  }
  return (
    <dl className="divide-y divide-border text-sm">
      {fields.map((f) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer convenience only — the inner control is itself focusable and keyboard-operable
        // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users Tab straight to the control; the row click just forwards the pointer
        <div
          key={f.id}
          className="flex items-center justify-between gap-4 px-6 py-2"
          onClick={editable ? forwardRowClick : undefined}
        >
          <dt className="shrink-0 text-muted-foreground">{f.name}</dt>
          <dd className={editable ? "min-w-0 flex-1 text-right" : "text-right"}>
            {editable ? (
              <DetailFieldEditor field={f} recordVersion={recordVersion} onSave={saveCell} />
            ) : (
              <FieldValueCell field={f} value={recordVersion.state[f.id]} />
            )}
          </dd>
        </div>
      ))}
      {extras.map((k) => (
        <div key={k} className="flex items-center justify-between px-6 py-2">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right text-foreground">{showValue(recordVersion.state[k])}</dd>
        </div>
      ))}
    </dl>
  )
}
