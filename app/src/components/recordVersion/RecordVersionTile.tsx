import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { TileContentKey } from "../../lib/recordViews"
import { Card, CardHeader } from "../ui"
import { TILE_CONTENTS } from "./registry"
import type { RecordVersionCtx } from "./types"

/**
 * One view tile: a single content renders as a titled card; two or more render
 * as a tabbed card (the tabs rule — anything tileable is tabbable). The active
 * tab's header actions sit right of the tab strip. `contents` must already be
 * availability-filtered and non-empty (the canvas prunes).
 */
export function RecordVersionTile({
  contents,
  ctx,
}: {
  contents: ReadonlyArray<TileContentKey>
  ctx: RecordVersionCtx
}) {
  const [tab, setTab] = useState<TileContentKey>(contents[0]!)

  if (contents.length === 1) {
    const c = TILE_CONTENTS[contents[0]!]
    return (
      <Card className="flex h-full min-h-0 flex-col">
        <CardHeader
          title={
            <span className="flex items-center gap-1.5">
              <c.Icon size={15} className="text-muted-foreground" />
              {c.title}
              {c.Count && <c.Count ctx={ctx} />}
            </span>
          }
          action={c.Actions ? <c.Actions ctx={ctx} /> : undefined}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <c.Body ctx={ctx} />
        </div>
      </Card>
    )
  }

  // The remembered tab can disappear when availability changes — fall back.
  const active = contents.includes(tab) ? tab : contents[0]!
  const ActiveActions = TILE_CONTENTS[active].Actions
  return (
    <Card className="flex h-full min-h-0 flex-col">
      <Tabs
        value={active}
        onValueChange={(v) => setTab(v as TileContentKey)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border pr-3">
          <TabsList variant="line" className="h-auto px-3 pt-1.5">
            {contents.map((k) => {
              const c = TILE_CONTENTS[k]
              return (
                <TabsTrigger key={k} value={k} className="flex-none px-3">
                  <c.Icon size={15} /> {c.title}
                  {c.Count && <c.Count ctx={ctx} />}
                </TabsTrigger>
              )
            })}
          </TabsList>
          {ActiveActions && (
            <div className="py-1.5">
              <ActiveActions ctx={ctx} />
            </div>
          )}
        </div>
        {contents.map((k) => {
          const c = TILE_CONTENTS[k]
          return (
            <TabsContent key={k} value={k} className="min-h-0 flex-1 overflow-y-auto">
              <c.Body ctx={ctx} />
            </TabsContent>
          )
        })}
      </Tabs>
    </Card>
  )
}
