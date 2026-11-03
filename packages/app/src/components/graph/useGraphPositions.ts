import type { Node } from "@xyflow/react"
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react"
import type { GraphLayout } from "../../lib/api"

/** Sub-pixel jitter (measure/round-trips) must not count as an edit. */
const EPS = 0.5

const snapshotOf = (nodes: ReadonlyArray<Node>): GraphLayout =>
  Object.fromEntries(nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }]))

/**
 * Position state for a graph canvas (concept graph, record relationship graph).
 * The layout is shared org-wide, so nothing persists on its own: edits (drags,
 * layouts, undo/redo) stay local until the user saves. Two concerns:
 *
 * - **Explicit save against a baseline.** `baseline` is what's on the server
 *   (or what the canvas showed on open); `dirty` = any node moved off it.
 *   `save()` sends EVERY current position — not a dirty subset — so the stored
 *   layout always matches what the saver saw, including nodes that were only
 *   ever placed by a fallback/initial layout. `discard()` snaps back to it.
 *   `adoptAsBaseline()` marks the current positions as the starting point
 *   without saving (the first-open Auto layout, which re-runs identically on
 *   every visit until someone saves).
 *
 * - **Client-side undo/redo.** Snapshot history in refs (capped at 100); one
 *   drag or one layout application = one step. ⌘Z/⇧⌘Z/Ctrl+Y are handled
 *   while the event target is inside the React Flow pane. Saving or
 *   discarding clears it.
 */
export function useGraphPositions(
  nodes: Node[],
  setNodes: Dispatch<SetStateAction<Node[]>>,
  save: (positions: GraphLayout) => Promise<unknown>,
) {
  const nodesRef = useRef(nodes)
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  const currentPositions = useCallback((): GraphLayout => snapshotOf(nodesRef.current), [])

  // ── baseline + dirty ────────────────────────────────────────────────────────
  const [baseline, setBaseline] = useState<GraphLayout>(() => snapshotOf(nodes))
  const dirty = nodes.some((n) => {
    const b = baseline[n.id]
    return !b || Math.abs(b.x - n.position.x) > EPS || Math.abs(b.y - n.position.y) > EPS
  })

  // ── undo/redo over position snapshots ───────────────────────────────────────
  // Refs hold the stacks (no re-render per tick); `bump` refreshes button state.
  const history = useRef<{ past: GraphLayout[]; future: GraphLayout[] }>({ past: [], future: [] })
  const [, bump] = useReducer((c: number) => c + 1, 0)
  const clearHistory = useCallback(() => {
    history.current = { past: [], future: [] }
    bump()
  }, [])
  const pushPast = useCallback((snapshot: GraphLayout) => {
    history.current.past.push(snapshot)
    if (history.current.past.length > 100) history.current.past.shift()
    history.current.future = []
    bump()
  }, [])
  /** Record the CURRENT positions as an undo step (call before applying a change). */
  const pushHistory = useCallback(() => {
    pushPast(currentPositions())
  }, [pushPast, currentPositions])

  const applyPositions = useCallback(
    (layout: GraphLayout) => {
      setNodes((ns) => ns.map((n) => ({ ...n, position: layout[n.id] ?? n.position })))
    },
    [setNodes],
  )
  const undo = useCallback(() => {
    const prev = history.current.past.pop()
    if (!prev) return
    history.current.future.push(currentPositions())
    applyPositions(prev)
    bump()
  }, [applyPositions, currentPositions])
  const redo = useCallback(() => {
    const next = history.current.future.pop()
    if (!next) return
    history.current.past.push(currentPositions())
    applyPositions(next)
    bump()
  }, [applyPositions, currentPositions])

  // Cmd/Ctrl+Z / Shift+Cmd+Z (or Ctrl+Y) while interacting with the canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const target = e.target as HTMLElement | null
      if (!target?.closest(".react-flow")) return
      if (e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo])

  // A drag is one undo step: snapshot at grab, commit at release.
  const dragSnap = useRef<GraphLayout | null>(null)
  const onNodeDragStart = useCallback(() => {
    dragSnap.current = currentPositions()
  }, [currentPositions])
  const onNodeDragStop = useCallback(() => {
    if (dragSnap.current) {
      pushPast(dragSnap.current)
      dragSnap.current = null
    }
  }, [pushPast])

  // ── save / discard ──────────────────────────────────────────────────────────
  const savePositions = useCallback(async () => {
    const snapshot = currentPositions()
    await save(snapshot)
    setBaseline(snapshot)
    clearHistory()
  }, [save, currentPositions, clearHistory])
  const discard = useCallback(() => {
    applyPositions(baseline)
    clearHistory()
  }, [applyPositions, baseline, clearHistory])
  /** Treat these positions as the unsaved-free starting point (no request). */
  const adoptAsBaseline = useCallback((layout: GraphLayout) => setBaseline(layout), [])

  return {
    dirty,
    savePositions,
    discard,
    adoptAsBaseline,
    pushHistory,
    undo,
    redo,
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
    onNodeDragStart,
    onNodeDragStop,
  }
}
