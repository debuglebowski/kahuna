import { Check, LayoutGrid, Pencil } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  CUSTOM_VIEW_KEY,
  customTiles,
  DEFAULT_VIEW_KEY,
  INSTANCE_VIEWS,
  resolveViewKey,
  useInstanceViewPrefs,
} from "../../lib/instanceViews"
import { Button } from "../ui"

/**
 * Pick the layout for this concept's instances (saved per user + concept) —
 * a preset, or this concept's custom layout once one is saved. "Use as my
 * default" promotes the current preset and clears the concept override so
 * later default changes follow (customs are per-concept, so not promotable).
 */
export function ViewSwitcher({
  conceptId,
  onEditLayout,
}: {
  conceptId: string
  onEditLayout: () => void
}) {
  const { body, update } = useInstanceViewPrefs()
  const current = resolveViewKey(body, conceptId)
  const hasCustom = customTiles(body, conceptId).length > 0
  const isMyDefault =
    body.byConcept[conceptId] == null && (body.defaultView ?? DEFAULT_VIEW_KEY) === current

  const setForConcept = (key: string) =>
    update.mutate({ ...body, byConcept: { ...body.byConcept, [conceptId]: key } })
  const makeDefault = () => {
    const { [conceptId]: _drop, ...rest } = body.byConcept
    update.mutate({ ...body, defaultView: current, byConcept: rest })
  }
  const resetCustom = () => {
    const { [conceptId]: _layout, ...customRest } = body.customByConcept
    const { [conceptId]: override, ...byRest } = body.byConcept
    update.mutate({
      ...body,
      byConcept: override === CUSTOM_VIEW_KEY ? byRest : body.byConcept,
      customByConcept: customRest,
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="shrink-0" aria-label="Change layout">
          <LayoutGrid size={15} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {INSTANCE_VIEWS.map((v) => (
          <DropdownMenuItem key={v.key} onSelect={() => setForConcept(v.key)}>
            <Check size={15} className={v.key === current ? "" : "invisible"} />
            {v.name}
          </DropdownMenuItem>
        ))}
        {hasCustom && (
          <DropdownMenuItem onSelect={() => setForConcept(CUSTOM_VIEW_KEY)}>
            <Check size={15} className={current === CUSTOM_VIEW_KEY ? "" : "invisible"} />
            Custom
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onEditLayout}>
          <Pencil size={15} />
          Edit layout
        </DropdownMenuItem>
        {hasCustom && (
          <DropdownMenuItem onSelect={resetCustom}>Reset custom layout</DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={isMyDefault || current === CUSTOM_VIEW_KEY}
          onSelect={makeDefault}
        >
          Use as my default
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
