import { BaseEdge, EdgeLabelRenderer, type EdgeProps, useInternalNode } from "@xyflow/react"
import { labelStyle, roundedPath, selfLoopGeometry, smoothPath } from "../../lib/graphRouting"

/**
 * An edge pointing back at its own node, drawn as a small loop around the
 * box's top-right CORNER: out of the top edge, round the corner, back into the
 * right side with the arrow. Corners are where routed lines rarely attach (they
 * spread out from the middle of each side), so the loop stays clear of them.
 *
 * Geometry lives in `selfLoopGeometry` so the router can keep other lines and
 * labels clear of the loop. Drawn with the same line style as routed edges — `data.cornerRadius` /
 * `data.smooth`, as set by the canvas look settings — so it reads as one of
 * them. Geometry comes from the node's measured box. Shared by the concept
 * graph canvas and the record relationship graph.
 */
export function SelfLoopEdge({ id, source, label, markerEnd, style, data }: EdgeProps) {
  const node = useInternalNode(source)
  const w = node?.measured.width
  const h = node?.measured.height
  if (!node || !w || !h) return null
  const { x: px, y: py } = node.internals.positionAbsolute

  const { points: pts, labelAt } = selfLoopGeometry({ x: px, y: py, w, h })
  const radius = typeof data?.cornerRadius === "number" ? data.cornerRadius : 8
  const path = data?.smooth === true ? smoothPath(pts) : roundedPath(pts, radius)

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            // Just outside the loop's outer corner, reading away from the box.
            style={{
              ...labelStyle(typeof data?.labelScale === "number" ? data.labelScale : 100),
              transform: `translate(0, -50%) translate(${labelAt.x}px, ${labelAt.y}px)`,
            }}
            className="pointer-events-none absolute whitespace-nowrap bg-card font-medium text-foreground"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
