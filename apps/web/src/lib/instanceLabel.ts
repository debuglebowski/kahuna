import type { Field, Instance } from "./api"
import { isRichTextEmpty, richTextPreview } from "./richtext"
import { showValue } from "./utils"

/** A display name for an instance: its first non-empty text field, else its
 *  first non-empty rich text field, else any non-synthetic string value, else
 *  a placeholder (mirrors the detail view). */
export const instanceLabel = (inst: Instance, fields: readonly Field[]): string => {
  const text = fields.find((f) => f.kind === "text" && inst.state[f.id])
  if (text) return showValue(inst.state[text.id])
  const rich = fields.find((f) => f.kind === "richtext" && !isRichTextEmpty(inst.state[f.id]))
  if (rich) return richTextPreview(inst.state[rich.id], 80)
  for (const [k, v] of Object.entries(inst.state)) {
    if (!k.startsWith("__") && typeof v === "string" && v) return v
  }
  return "(untitled)"
}
