import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { NormWidget } from "@/lib/dashboards"
import { resolveVariantId, variantPatch, variantsFor } from "@/lib/variantCatalog"
import { Field as FieldRow } from "../ui"

/**
 * The unified "Variant" control for every widget — reads the widget's variants from
 * `VARIANT_CATALOG`, so wiring a new variant is purely a catalog edit (no editor
 * changes). Selecting a variant applies its preset patch alongside the id via
 * `variantPatch`. Renders nothing when the type has fewer than two variants, so
 * it's safe to drop into every widget's config section.
 */
export function VariantPicker({
  widget,
  onChange,
}: {
  widget: NormWidget
  onChange: (patch: Partial<NormWidget>) => void
}) {
  const variants = variantsFor(widget.type)
  if (variants.length < 2) return null
  const current = resolveVariantId(widget) ?? variants[0]?.id

  return (
    <FieldRow label="Variant">
      <Select
        value={current}
        onValueChange={(id) => onChange(variantPatch(widget.type, id) as Partial<NormWidget>)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {variants.map((v) => (
            <SelectItem key={v.id} value={v.id}>
              {v.Preview ? <v.Preview /> : null}
              {v.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  )
}
