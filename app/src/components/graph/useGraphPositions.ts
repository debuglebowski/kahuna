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

/**
 * Position state management for a graph canvas (concept graph, record version
 * relationship graph), split out of the components so a canvas only wires
 * handlers and renders status. The caller supplies `save` — a partial-patch
 * persister (node id → position) — so each canvas brings its own endpoint.
 * Two concerns:
 *
 * - **Debounced dirty-set persistence.** Changed node ids accumulate and a
 *   debounced flush sends only those entries as a PATCH — the server
 *   jsonb-merges per node, so concurrent editors moving different nodes don't
 *   clobber each other. Failures re-queue the patch and retry (×5, 3s apart)
 *   with the state surfaced via `saveState`; pending work also flushes when
 *   the tab is hidden or the canvas unmounts.
 *
 * - **Client-side undo/redo.** Snapshot history in refs (capped at 100); one
 *   drag or one layout application = one step. ⌘Z/⇧⌘Z/Ctrl+Y are handled
 *   while the event target is inside the React Flow pane.
 */
export function useGraphPositions(
  nodes: Node[],
  setNodes: Dispatch<SetStateAction<Node[]>>,
  save: (patch: GraphLayout) => Promise<unknown>,
) {
  const nodesRef = useRef(nodes)
  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])
  const currentPositions = useCallback((): GraphLayout => {
    return Object.fromEntries(nodesRef.current.map((n) => [n.id, { ...n.position }]))
  }, [])

  // ── debounced dirty-set persistence ─────────────────────────────────────────
  const dirty = useRef<Set<string>>(new Set())
  const retries = useRef(0)
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle")
  const markDirty = useCallback((ids: ReadonlyArray<string> | "all") => {
    const list = ids === "all" ? nodesRef.current.map((n) => n.id) : ids
    for (const id of list) dirty.current.add(id)
  }, [])

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback(() => {
    if (dirty.current.size === 0) return
    const sending = [...dirty.current]
    dirty.current.clear()
    const byId = new Map(nodesRef.current.map((n) => [n.id, n.position]))
    const patch: GraphLayout = Object.fromEntries(
      sending.flatMap((id) => {
        const p = byId.get(id)
        return p ? [[id, { x: p.x, y: p.y }] as const] : []
      }),
    )
    setSaveState("saving")
    save(patch).then(
      () => {
        retries.current = 0
        setSaveState(dirty.current.size > 0 ? "saving" : "idle")
      },
      (e) => {
        console.warn("graph layout save failed", e)
        // Re-queue what we tried to send (newer moves are already in `dirty`)
        // and retry a few times; afterwards, the next user change retries.
        for (const id of sending) dirty.current.add(id)
        setSaveState("error")
        if (retries.current < 5) {
          retries.current += 1
          saveTimer.current = setTimeout(flush, 3000)
        }
      },
    )
  }, [save])
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    retries.current = 0
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      flush()
    }, 800)
  }, [flush])

  // Flush pending work when the tab goes hidden (covers most tab-close races —
  // the request starts while the page is still alive) and on unmount.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== "hidden" || dirty.current.size === 0) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      flush()
    }
    document.addEventListener("visibilitychange", onHide)
    return () => document.removeEventListener("visibilitychange", onHide)
  }, [flush])
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (dirty.current.size > 0) flush()
    },
    [flush],
  )

  // ── undo/redo over position snapshots ───────────────────────────────────────
  // Refs hold the stacks (no re-render per tick); `bump` refreshes button state.
  const history = useRef<{ past: GraphLayout[]; future: GraphLayout[] }>({ past: [], future: [] })
  const [, bump] = useReducer((c: number) => c + 1, 0)
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
      markDirty("all")
      scheduleSave()
    },
    [setNodes, markDirty, scheduleSave],
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
  const onNodeDragStop = useCallback(
    (_e: unknown, node: Node, dragged: Node[]) => {
      if (dragSnap.current) {
        pushPast(dragSnap.current)
        dragSnap.current = null
      }
      markDirty(dragged.length > 0 ? dragged.map((n) => n.id) : [node.id])
      scheduleSave()
    },
    [pushPast, markDirty, scheduleSave],
  )

  return {
    saveState,
    markDirty,
    scheduleSave,
    pushHistory,
    undo,
    redo,
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
    onNodeDragStart,
    onNodeDragStop,
  }
}
