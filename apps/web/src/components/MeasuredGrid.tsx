import { useLayoutEffect, useRef, useState } from "react"
import GridLayout, { type Layout } from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import "react-resizable/css/styles.css"
import type { GridItem } from "@/lib/dashboards"
import { GRID_COLS, GRID_ROW_HEIGHT } from "@/lib/dashboards"

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
 * The one RGL setup shared by every canvas surface (dashboards, member pages,
 * instance view editor): self-measured width plus the house grid constants.
 * Children must be keyed by their layout item id, as RGL requires.
 */
export function MeasuredGrid({
  layout,
  isDraggable = true,
  isResizable = true,
  onStop,
  children,
}: {
  layout: GridItem[]
  isDraggable?: boolean
  isResizable?: boolean
  onStop?: (layout: Layout[]) => void
  children: React.ReactNode
}) {
  const { ref, width } = useMeasuredWidth()
  return (
    <div ref={ref} className="-mx-1">
      {width !== null && (
        <GridLayout
          width={width}
          layout={layout}
          cols={GRID_COLS}
          rowHeight={GRID_ROW_HEIGHT}
          margin={[12, 12]}
          draggableCancel=".cancel-drag"
          isDraggable={isDraggable}
          isResizable={isResizable}
          onDragStop={onStop}
          onResizeStop={onStop}
          isBounded
        >
          {children}
        </GridLayout>
      )}
    </div>
  )
}
