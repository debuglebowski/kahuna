import type { Field, Instance } from "./api"
import { isRichTextEmpty, richTextPreview } from "./richtext"
import { showValue } from "./utils"

/** A display name for an instance. When the concept designates a `titleFieldId`
 *  (any scalar field), its value IS the label — empty ⇒ the fallback. Only when
 *  unset (an as-yet-unconfigured concept) does it fall back to the legacy guess:
 *  first non-empty text field, then rich text, then any non-synthetic string.
 *
 *  `fallbackLabel` replaces "(untitled)" for records that have a name of their own
 *  independent of their data — a single-record concept's record IS the concept, so
 *  it reads as "Company", never "(untitled)". Passed as a string rather than the
 *  whole `Concept` so the pure helper stays free of the contract type. */
export const instanceLabel = (
  inst: Instance,
  fields: readonly Field[],
  titleFieldId?: string | null,
  fallbackLabel?: string,
): string => {
  const untitled = fallbackLabel?.trim() || "(untitled)"
  if (titleFieldId) {
    const v = inst.state[titleFieldId]
    if (v === undefined || v === null || v === "") return untitled
    const field = fields.find((f) => f.id === titleFieldId)
    return field?.kind === "richtext" ? richTextPreview(v, 80) : showValue(v)
  }
  const text = fields.find((f) => f.kind === "text" && inst.state[f.id])
  if (text) return showValue(inst.state[text.id])
  const rich = fields.find((f) => f.kind === "richtext" && !isRichTextEmpty(inst.state[f.id]))
  if (rich) return richTextPreview(inst.state[rich.id], 80)
  for (const [k, v] of Object.entries(inst.state)) {
    if (!k.startsWith("__") && typeof v === "string" && v) return v
  }
  return untitled
}
