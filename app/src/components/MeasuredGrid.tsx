import { useEffect, useLayoutEffect, useRef, useState } from "react"
import GridLayout, { type Layout } from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import "react-resizable/css/styles.css"

/** A react-grid-layout item (subset we use). The coarse 12-col grid that backs
 *  the instance-view editor — dashboards moved to a flexbox auto-layout tree. */
export interface GridItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
}

// Coarse grid (the instance-view editor's). cols/rowHeight/margin are props so a
// caller can override; nothing overrides them today.
const DEFAULT_COLS = 12
const DEFAULT_ROW_HEIGHT = 72
const DEFAULT_MARGIN = 12

/**
 * Container width for the grid, measured before first paint so tiles mount at
 * their final positions (RGL's WidthProvider mounts at a 1280px default and
 * animates tiles into place on remeasure; its measureBeforeMount mode leaks
 * its ResizeObserver onto the swapped-out placeholder node and goes deaf to
 * later resizes). Observing our own persistent wrapper avoids both.
 */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    setWidth(node.getBoundingClientRect().width)
    const observer = new ResizeObserver(() => {
      setWidth(node.getBoundingClientRect().width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/**
 * The inner (padding-excluded) height of a container, tracked live. Feed the
 * result into `<MeasuredGrid minHeight>` to make the grid fill that box: the
 * canvas expands to the available height instead of hugging its content, and
 * RGL's bounded drag (which clamps to the container's `clientHeight`) lets you
 * place tiles anywhere in the filled area. Attach `ref` to the element whose
 * content box you want the grid to fill (e.g. the editor's canvas box).
 */
export function useFillHeight<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)
  const [height, setHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => {
      const cs = getComputedStyle(node)
      const pad = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom)
      setHeight(Math.max(0, node.clientHeight - pad))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return { ref, height }
}

/**
 * The one RGL setup shared by every canvas surface (dashboards, member pages,
 * instance view editor): self-measured width plus the house grid constants.
 * Children must be keyed by their layout item id, as RGL requires.
 */
export function MeasuredGrid({
  layout,
  isDraggable = true,
  isResizable = true,
  minHeight,
  onStop,
  onDragStart,
  onWidth,
  cols = DEFAULT_COLS,
  rowHeight = DEFAULT_ROW_HEIGHT,
  margin = DEFAULT_MARGIN,
  children,
}: {
  layout: GridItem[]
  isDraggable?: boolean
  isResizable?: boolean
  /** When set, the grid container fills at least this many px (it still grows
   *  past it for taller layouts) — an expandable canvas instead of one that
   *  hugs its content. See {@link useFillHeight}. */
  minHeight?: number | null
  onStop?: (layout: Layout[]) => void
  /** Fires with the item id when a tile is grabbed (RGL fires this on press, so
   *  it's a reliable click-to-select even though the drag lifecycle re-renders
   *  the tile and swallows the native click). */
  onDragStart?: (id: string) => void
  /** Reports the measured grid container width (px) — feeds the px/% size
   *  conversions in the dashboard editor's widget config panel. */
  onWidth?: (width: number) => void
  /** Grid resolution. Defaults to the coarse instance-view grid; the dashboard
   *  passes a fine grid (≈1px cells, no gutter) for continuous sizing. */
  cols?: number
  rowHeight?: number
  margin?: number
  children: React.ReactNode
}) {
  const { ref, width } = useMeasuredWidth()
  useEffect(() => {
    if (width !== null) onWidth?.(width)
  }, [width, onWidth])
  return (
    <div ref={ref} className="-mx-1">
      {width !== null && (
        <GridLayout
          width={width}
          layout={layout}
          cols={cols}
          rowHeight={rowHeight}
          margin={[margin, margin]}
          draggableCancel=".cancel-drag"
          isDraggable={isDraggable}
          isResizable={isResizable}
          onDragStart={onDragStart ? (_layout, item) => onDragStart(item.i) : undefined}
          onDragStop={onStop}
          onResizeStop={onStop}
          style={minHeight != null ? { minHeight } : undefined}
          isBounded
        >
          {children}
        </GridLayout>
      )}
    </div>
  )
}
