import { BaseEdge, type EdgeProps, useInternalNode } from "@xyflow/react"

type Box = { x: number; y: number; w: number; h: number }

const boxOf = (n: ReturnType<typeof useInternalNode>): Box | null => {
  const w = n?.measured.width ?? n?.width
  const h = n?.measured.height ?? n?.height
  if (!n || !w || !h) return null
  const { x, y } = n.internals.positionAbsolute
  return { x, y, w, h }
}

/**
 * The short connector from a card to its satellite (see `satellites.ts`): a
 * straight line between the two boxes' FACING sides. Not routed — a satellite
 * sits right next to its parent, and the router's clearance would otherwise
 * bend this into a detour around both.
 */
export function SatelliteEdge({ id, source, target, markerEnd, style }: EdgeProps) {
  const p = boxOf(useInternalNode(source))
  const s = boxOf(useInternalNode(target))
  if (!p || !s) return null
  const scx = s.x + s.w / 2
  const scy = s.y + s.h / 2
  // Which side the satellite is on decides the facing edges.
  const horizontal = s.x >= p.x + p.w || s.x + s.w <= p.x
  let path: string
  if (horizontal) {
    const right = s.x >= p.x + p.w
    const y = (Math.max(p.y, s.y) + Math.min(p.y + p.h, s.y + s.h)) / 2 || scy
    path = right ? `M ${p.x + p.w} ${y} L ${s.x} ${y}` : `M ${p.x} ${y} L ${s.x + s.w} ${y}`
  } else {
    const below = s.y >= p.y + p.h
    const x = (Math.max(p.x, s.x) + Math.min(p.x + p.w, s.x + s.w)) / 2 || scx
    path = below ? `M ${x} ${p.y + p.h} L ${x} ${s.y}` : `M ${x} ${p.y} L ${x} ${s.y + s.h}`
  }
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
}
