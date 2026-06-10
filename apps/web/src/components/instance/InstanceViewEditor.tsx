import { ArrowDown, ArrowUp, Check, Pencil, Plus, X } from "lucide-react"
import { useLayoutEffect, useRef, useState } from "react"
import GridLayout, { type Layout } from "react-grid-layout"
import "react-grid-layout/css/styles.css"
import "react-resizable/css/styles.css"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { GRID_COLS, GRID_ROW_HEIGHT } from "@/lib/dashboards"
import { TILE_CONTENT_KEYS, type TileContentKey, type ViewTile } from "../../lib/instanceViews"
import { Button } from "../ui"
import { InstanceTile } from "./InstanceTile"
import { availableContents, TILE_CONTENTS } from "./registry"
import type { InstanceCtx } from "./types"

/** See WidgetCanvas: measure our own wrapper before first paint so tiles mount
 *  at their final positions (RGL's WidthProvider animates from a 1280px guess). */
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

/** Reorder/remove this box's contents and add from the remaining catalog.
 *  Removing the last content removes the whole box (an empty box can't render). */
function TileContentsEditor({
  tile,
  ctx,
  onChange,
  onRemoveTile,
}: {
  tile: ViewTile
  ctx: InstanceCtx
  onChange: (contents: TileContentKey[]) => void
  onRemoveTile: () => void
}) {
  const addable = availableContents(TILE_CONTENT_KEYS, ctx).filter(
    (k) => !tile.contents.includes(k),
  )
  const move = (i: number, dir: -1 | 1) => {
    const next = [...tile.contents]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    onChange(next)
  }
  const remove = (i: number) => {
    const next = tile.contents.filter((_, idx) => idx !== i)
    if (next.length === 0) onRemoveTile()
    else onChange([...next])
  }
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        Contents — two or more become tabs
      </p>
      <div className="space-y-0.5">
        {tile.contents.map((k, i) => {
          const c = TILE_CONTENTS[k]
          return (
            <div key={k} className="flex items-center gap-1.5 rounded px-1 py-0.5 text-sm">
              <c.Icon size={14} className="text-muted-foreground" />
              <span className="flex-1 text-foreground">{c.title}</span>
              <button
                type="button"
                aria-label={`Move ${c.title} up`}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                aria-label={`Move ${c.title} down`}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                disabled={i === tile.contents.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                aria-label={`Remove ${c.title}`}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => remove(i)}
              >
                <X size={13} />
              </button>
            </div>
          )
        })}
      </div>
      {addable.length > 0 && (
        <div className="space-y-0.5 border-t border-border pt-2">
          {addable.map((k) => {
            const c = TILE_CONTENTS[k]
            return (
              <button
                key={k}
                type="button"
                className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onChange([...tile.contents, k])}
              >
                <c.Icon size={14} />
                <span className="flex-1">{c.title}</span>
                <Plus size={13} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Edit mode for the instance view: the current layout on a live RGL grid —
 * drag/resize boxes, edit each box's contents (tabs), add boxes from the
 * catalog. Purely local state until "Save"; the parent persists the result as
 * this concept's custom layout. Tile bodies render inert (pointer-events-none)
 * so a drag can start anywhere on the tile.
 */
export function InstanceViewEditor({
  initial,
  ctx,
  onSave,
  onCancel,
  saving,
}: {
  initial: ReadonlyArray<ViewTile>
  ctx: InstanceCtx
  onSave: (tiles: ViewTile[]) => void
  onCancel: () => void
  saving: boolean
}) {
  const { ref, width } = useMeasuredWidth()
  // Start from what's on screen, minus contents this concept can't show.
  const [tiles, setTiles] = useState<ViewTile[]>(() =>
    initial
      .map((t) => ({ ...t, contents: availableContents(t.contents, ctx) }))
      .filter((t) => t.contents.length > 0),
  )

  const applyLayout = (layout: Layout[]) =>
    setTiles((ts) =>
      ts.map((t) => {
        const g = layout.find((l) => l.i === t.id)
        return g ? { ...t, x: g.x, y: g.y, w: g.w, h: g.h } : t
      }),
    )
  const setContents = (id: string, contents: TileContentKey[]) =>
    setTiles((ts) => ts.map((t) => (t.id === id ? { ...t, contents } : t)))
  const removeTile = (id: string) => setTiles((ts) => ts.filter((t) => t.id !== id))
  const addTile = (key: TileContentKey) =>
    setTiles((ts) => [
      ...ts,
      {
        id: crypto.randomUUID(),
        contents: [key],
        x: 0,
        y: ts.reduce((m, t) => Math.max(m, t.y + t.h), 0),
        w: 4,
        h: 3,
      },
    ])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-2">
        <span className="text-sm text-muted-foreground">
          Editing layout — drag and resize boxes; a box with several contents shows them as tabs.
        </span>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Plus size={15} />
                Add box
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {availableContents(TILE_CONTENT_KEYS, ctx).map((k) => {
                const c = TILE_CONTENTS[k]
                return (
                  <DropdownMenuItem key={k} onSelect={() => addTile(k)}>
                    <c.Icon size={15} />
                    {c.title}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onSave(tiles)} disabled={saving || tiles.length === 0}>
            <Check size={15} />
            {saving ? "Saving…" : "Save layout"}
          </Button>
        </div>
      </div>

      <div ref={ref} className="-mx-1">
        {width !== null && (
          <GridLayout
            width={width}
            layout={tiles.map((t) => ({
              i: t.id,
              x: t.x,
              y: t.y,
              w: t.w,
              h: t.h,
              minW: 2,
              minH: 2,
            }))}
            cols={GRID_COLS}
            rowHeight={GRID_ROW_HEIGHT}
            margin={[12, 12]}
            draggableCancel=".cancel-drag"
            onDragStop={applyLayout}
            onResizeStop={applyLayout}
            isBounded
          >
            {tiles.map((t) => (
              <div key={t.id} className="group relative">
                <div className="pointer-events-none h-full select-none">
                  <InstanceTile contents={t.contents} ctx={ctx} />
                </div>
                <div className="cancel-drag absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-md border border-border bg-card/95 p-0.5 shadow-sm">
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label="Edit box contents"
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Pencil size={13} />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-64">
                      <TileContentsEditor
                        tile={t}
                        ctx={ctx}
                        onChange={(contents) => setContents(t.id, contents)}
                        onRemoveTile={() => removeTile(t.id)}
                      />
                    </PopoverContent>
                  </Popover>
                  <button
                    type="button"
                    aria-label="Remove box"
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => removeTile(t.id)}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            ))}
          </GridLayout>
        )}
      </div>
    </div>
  )
}
