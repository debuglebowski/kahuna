import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react"

/** An edge pointing back at its own node — drawn as a loop above the node.
 *  Shared by the concept graph canvas and the record version relationship graph. */
export function SelfLoopEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  markerEnd,
  style,
}: EdgeProps) {
  const path = `M ${sourceX} ${sourceY} C ${sourceX + 70} ${sourceY - 80}, ${targetX - 70} ${targetY - 80}, ${targetX} ${targetY}`
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${Math.min(sourceY, targetY) - 64}px)`,
            }}
            className="pointer-events-none absolute rounded bg-card px-1.5 py-0.5 text-[11px] font-medium text-foreground"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
