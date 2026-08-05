import { useEffect, useState } from "react"
import type { RecordViewDef } from "../../lib/recordViews"
import { RecordVersionTile } from "./RecordVersionTile"
import { availableContents, capsOf } from "./registry"
import type { RecordVersionCtx } from "./types"

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
 * Read-only renderer for a record version view: tiles on a 12-column CSS grid that
 * fills the available height — rows split it evenly (with a floor so cramped
 * layouts scroll rather than crush tile headers) and tiles scroll internally.
 * On narrow screens the grid collapses to one scrolling column in reading
 * order, with tiles back at their natural height.
 */
export function RecordVersionViewCanvas({
  view,
  ctx,
}: {
  view: RecordViewDef
  ctx: RecordVersionCtx
}) {
  const wide = useIsWide()
  const caps = capsOf(ctx)
  const tiles = view
    .tiles(caps)
    .map((t) => ({ ...t, contents: availableContents(t.contents, caps) }))
    .filter((t) => t.contents.length > 0)

  if (!wide)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {[...tiles]
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((t) => (
            <div key={t.id} className="shrink-0">
              <RecordVersionTile contents={t.contents} ctx={ctx} />
            </div>
          ))}
      </div>
    )

  const rows = Math.max(1, ...tiles.map((t) => t.y + t.h))
  return (
    <div
      className="grid min-h-0 flex-1 gap-3 overflow-y-auto"
      style={{
        gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
        gridTemplateRows: `repeat(${rows}, minmax(3.5rem, 1fr))`,
      }}
    >
      {tiles.map((t) => (
        <div
          key={t.id}
          className="min-h-0 min-w-0"
          style={{
            gridColumn: `${t.x + 1} / span ${t.w}`,
            gridRow: `${t.y + 1} / span ${t.h}`,
          }}
        >
          <RecordVersionTile contents={t.contents} ctx={ctx} />
        </div>
      ))}
    </div>
  )
}
