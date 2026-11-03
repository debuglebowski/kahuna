import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  Position,
  useInternalNode,
} from "@xyflow/react"

/** Loop geometry: endpoint spread along the node side, and how far it bulges out. */
const SPREAD = 12
const BULGE = 56

/** An edge pointing back at its own node — drawn as a small loop on a node side
 *  the flow handles don't use (right side for vertical layouts, top for
 *  horizontal), so it never crosses the node or tangles with other edges.
 *  Geometry comes from the node's measured box, not the handle points.
 *  Shared by the concept graph canvas and the record version relationship graph. */
export function SelfLoopEdge({ id, source, sourcePosition, label, markerEnd, style }: EdgeProps) {
  const node = useInternalNode(source)
  const w = node?.measured.width
  const h = node?.measured.height
  if (!node || !w || !h) return null
  const { x: px, y: py } = node.internals.positionAbsolute

  const vertical = sourcePosition === Position.Top || sourcePosition === Position.Bottom
  let path: string
  let labelTransform: string
  if (vertical) {
    // Loop off the right side; arrow re-enters below where it left.
    const x = px + w
    const cy = py + h / 2
    const y1 = cy - SPREAD
    const y2 = cy + SPREAD
    path = `M ${x} ${y1} C ${x + BULGE} ${y1 - BULGE / 2}, ${x + BULGE} ${y2 + BULGE / 2}, ${x} ${y2}`
    labelTransform = `translate(0, -50%) translate(${x + BULGE * 0.75 + 6}px, ${cy}px)`
  } else {
    // Loop off the top; arrow re-enters right of where it left.
    const y = py
    const cx = px + w / 2
    const x1 = cx - SPREAD
    const x2 = cx + SPREAD
    path = `M ${x1} ${y} C ${x1 - BULGE / 2} ${y - BULGE}, ${x2 + BULGE / 2} ${y - BULGE}, ${x2} ${y}`
    labelTransform = `translate(-50%, -100%) translate(${cx}px, ${y - BULGE * 0.75 - 4}px)`
  }

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            style={{ transform: labelTransform }}
            className="pointer-events-none absolute whitespace-nowrap rounded bg-card px-1.5 py-0.5 text-[11px] font-medium text-foreground"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
