import { useEffect, useState } from "react"
import type { InstanceViewDef } from "../../lib/instanceViews"
import { InstanceTile } from "./InstanceTile"
import { availableContents, capsOf } from "./registry"
import type { InstanceCtx } from "./types"

function useIsWide() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches)
  useEffect(() => {
    const m = window.matchMedia("(min-width: 1024px)")
    const onChange = () => setWide(m.matches)
    m.addEventListener("change", onChange)
    return () => m.removeEventListener("change", onChange)
  }, [])
  return wide
}

/**
 * Read-only renderer for an instance view: tiles on a 12-column CSS grid (rows
 * auto-size to content; tile coords stay grid-editor-compatible for later). On
 * narrow screens the grid collapses to one column in reading order.
 */
export function InstanceViewCanvas({ view, ctx }: { view: InstanceViewDef; ctx: InstanceCtx }) {
  const wide = useIsWide()
  const tiles = view
    .tiles(capsOf(ctx))
    .map((t) => ({ ...t, contents: availableContents(t.contents, ctx) }))
    .filter((t) => t.contents.length > 0)

  if (!wide)
    return (
      <div className="flex flex-col gap-3">
        {[...tiles]
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((t) => (
            <InstanceTile key={t.id} contents={t.contents} ctx={ctx} />
          ))}
      </div>
    )

  return (
    <div
      className="grid gap-3"
      style={{
        gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
        gridAutoRows: "minmax(0, auto)",
      }}
    >
      {tiles.map((t) => (
        <div
          key={t.id}
          className="min-w-0"
          style={{
            gridColumn: `${t.x + 1} / span ${t.w}`,
            gridRow: `${t.y + 1} / span ${t.h}`,
          }}
        >
          <InstanceTile contents={t.contents} ctx={ctx} />
        </div>
      ))}
    </div>
  )
}
