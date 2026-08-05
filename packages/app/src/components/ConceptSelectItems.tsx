import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select"
import type { Concept } from "@/lib/api"

/**
 * Renders a concept list as `<Select>` options split into "Org Concepts" and
 * "Integration Concepts" — the latter being concepts owned by an integration
 * (`managedBy != null`, e.g. Linear/Gmail/Calendar mirrors). Grouping by the
 * presence of `managedBy` keeps this generic — no concept names are special-cased.
 *
 * When only one group has members the items render flat (no headers); the split
 * only appears once there's something to separate, so orgs without integrations
 * see no extra chrome.
 *
 * Drop inside a `<SelectContent>`, after any sentinel row (e.g. a "none"/"any"
 * option). `label` defaults to the concept's plural name; pass a formatter where
 * the singular name is wanted.
 */
export function ConceptSelectItems({
  concepts,
  label = (c) => c.pluralName || c.name,
}: {
  concepts: readonly Concept[]
  label?: (concept: Concept) => string
}) {
  const org = concepts.filter((c) => !c.managedBy)
  const integration = concepts.filter((c) => c.managedBy)

  const item = (c: Concept) => (
    <SelectItem key={c.id} value={c.id}>
      {label(c)}
    </SelectItem>
  )

  if (org.length === 0 || integration.length === 0) return <>{concepts.map(item)}</>

  return (
    <>
      <SelectGroup>
        <SelectLabel>Org Concepts</SelectLabel>
        {org.map(item)}
      </SelectGroup>
      <SelectGroup className="mt-2">
        <SelectLabel>Integration Concepts</SelectLabel>
        {integration.map(item)}
      </SelectGroup>
    </>
  )
}
