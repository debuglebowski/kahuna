import {
  ArrowDown,
  ArrowUp,
  Check,
  LayoutTemplate,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { Layout } from "react-grid-layout"
import { MeasuredGrid, useFillHeight } from "@/components/MeasuredGrid"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { GridItem } from "@/lib/dashboards"
import {
  type ConceptCaps,
  INSTANCE_VIEWS,
  TILE_CONTENT_KEYS,
  type TileContentKey,
  type ViewTile,
} from "@/lib/instanceViews"
import { cn } from "@/lib/utils"
import { Button } from "../ui"
import { availableContents, TILE_CONTENTS } from "./registry"

/** One-line description per content, shown in the Add-tile gallery (the live
 *  panels need an instance, so the settings editor previews them schematically). */
const TILE_BLURB: Record<TileContentKey, string> = {
  details: "The instance's own fields.",
  document: "A rich-text document body.",
  connected: "Instances linked by relations.",
  graph: "A relationship graph around the instance.",
  labels: "The instance's labels.",
  versions: "Draft → published version history.",
  notes: "A freeform notes thread.",
  tasks: "A checklist of tasks.",
  files: "Attached files.",
  activity: "The change / activity feed.",
}

const serialize = (tiles: ReadonlyArray<ViewTile>) => JSON.stringify(tiles)

/** A structural preview of a tile (no live data — there's no instance here):
 *  the content header (or tab strip when several) over a muted body skeleton. */
function SchematicTile({
  contents,
  selected,
}: {
  contents: ReadonlyArray<TileContentKey>
  selected: boolean
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition-colors",
        selected ? "border-primary ring-2 ring-primary" : "hover:border-foreground/20",
      )}
    >
      {contents.length === 1 ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2 text-sm font-medium text-foreground">
          {(() => {
            const c = TILE_CONTENTS[contents[0]!]
            return (
              <>
                <c.Icon size={14} className="text-muted-foreground" />
                {c.title}
              </>
            )
          })()}
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5">
          {contents.map((k, i) => {
            const c = TILE_CONTENTS[k]
            return (
              <span
                key={k}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 text-xs whitespace-nowrap",
                  i === 0 ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                <c.Icon size={12} />
                {c.title}
              </span>
            )
          })}
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-2 p-3">
        <div className="h-2 w-1/3 rounded bg-muted" />
        <div className="h-2 w-3/4 rounded bg-muted" />
        <div className="h-2 w-2/3 rounded bg-muted" />
      </div>
    </div>
  )
}

/** Add-tile gallery — a dashboard-style modal of the content catalog (filtered to
 *  what this concept can show). Picking one adds a new single-content tile. */
function TileGallery({
  caps,
  onPick,
  onClose,
}: {
  caps: ConceptCaps
  onPick: (key: TileContentKey) => void
  onClose: () => void
}) {
  const keys = availableContents(TILE_CONTENT_KEYS, caps)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] w-[min(560px,94vw)] flex-col gap-0 p-0 sm:max-w-none">
        <div className="shrink-0 border-b py-3 pr-12 pl-5">
          <DialogTitle className="text-sm font-semibold">Add a tile</DialogTitle>
          <DialogDescription className="sr-only">
            Choose what this tile shows. Tiles holding more than one content render as tabs.
          </DialogDescription>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-5">
          {keys.map((k) => {
            const c = TILE_CONTENTS[k]
            return (
              <button
                key={k}
                type="button"
                onClick={() => {
                  onPick(k)
                  onClose()
                }}
                className="group flex w-full items-center gap-3 rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <c.Icon size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-foreground">{c.title}</span>
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                    {TILE_BLURB[k]}
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Inspector body for the selected tile: reorder / add / remove its contents
 *  (two or more render as tabs). Removing the last content removes the tile. */
function TileInspector({
  tile,
  caps,
  onChange,
  onRemoveTile,
}: {
  tile: ViewTile
  caps: ConceptCaps
  onChange: (contents: TileContentKey[]) => void
  onRemoveTile: () => void
}) {
  const addable = availableContents(TILE_CONTENT_KEYS, caps).filter(
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
    <div className="flex min-h-0 flex-1 flex-col gap-4">
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
      <Button
        variant="outline"
        size="sm"
        className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={onRemoveTile}
      >
        <Trash2 size={14} />
        Remove tile
      </Button>
    </div>
  )
}

/**
 * Concept-settings editor for a concept's default instance layout. A
 * dashboard-style two-pane surface: a seamless RGL canvas of schematic tiles on
 * the left (drag/resize/select), a tile inspector on the right. Holds a local
 * draft until Save; the parent persists it (or null, via "Reset to default").
 * Remounted (keyed on the saved layout) after each Save/Reset, so the baseline
 * always reflects what's stored.
 */
export function ConceptViewEditor({
  initialTiles,
  caps,
  isDefault,
  onSave,
  onResetDefault,
  saving,
  onDirtyChange,
}: {
  initialTiles: ReadonlyArray<ViewTile>
  caps: ConceptCaps
  /** True when the concept has no stored layout (rendering the built-in preset). */
  isDefault: boolean
  onSave: (tiles: ViewTile[]) => void
  onResetDefault: () => void
  saving: boolean
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [tiles, setTiles] = useState<ViewTile[]>(() =>
    initialTiles
      .map((t) => ({ ...t, contents: availableContents(t.contents, caps) }))
      .filter((t) => t.contents.length > 0),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const baseline = useRef(serialize(tiles))
  const { ref: canvasBoxRef, height: canvasHeight } = useFillHeight<HTMLDivElement>()

  const dirty = serialize(tiles) !== baseline.current
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])

  // Esc deselects (matches the dashboard editor); skip while the gallery is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !galleryOpen) setSelectedId(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [galleryOpen])

  const applyLayout = (layout: Layout[]) =>
    setTiles((ts) =>
      ts.map((t) => {
        const g = layout.find((l) => l.i === t.id)
        return g ? { ...t, x: g.x, y: g.y, w: g.w, h: g.h } : t
      }),
    )
  const setContents = (id: string, contents: TileContentKey[]) =>
    setTiles((ts) => ts.map((t) => (t.id === id ? { ...t, contents } : t)))
  const removeTile = (id: string) => {
    setTiles((ts) => ts.filter((t) => t.id !== id))
    setSelectedId((s) => (s === id ? null : s))
  }
  const addTile = (key: TileContentKey) => {
    const id = crypto.randomUUID()
    setTiles((ts) => [
      ...ts,
      { id, contents: [key], x: 0, y: ts.reduce((m, t) => Math.max(m, t.y + t.h), 0), w: 6, h: 4 },
    ])
    setSelectedId(id)
  }
  const startFromTemplate = (key: string) => {
    const def = INSTANCE_VIEWS.find((v) => v.key === key)
    if (!def) return
    setTiles(def.tiles(caps).map((t) => ({ ...t, contents: availableContents(t.contents, caps) })))
    setSelectedId(null)
  }
  const discard = () => {
    setTiles(JSON.parse(baseline.current) as ViewTile[])
    setSelectedId(null)
  }

  const selected = tiles.find((t) => t.id === selectedId) ?? null
  const layout: GridItem[] = tiles.map((t) => ({
    i: t.id,
    x: t.x,
    y: t.y,
    w: t.w,
    h: t.h,
    minW: 2,
    minH: 2,
  }))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setGalleryOpen(true)}>
          <Plus size={15} />
          Add tile
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <LayoutTemplate size={15} />
              Start from template
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {INSTANCE_VIEWS.map((v) => (
              <DropdownMenuItem key={v.key} onSelect={() => startFromTemplate(v.key)}>
                {v.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onResetDefault}
            disabled={saving || (isDefault && !dirty)}
            title="Clear this layout — instances fall back to the built-in default."
          >
            <RotateCcw size={14} />
            Reset to default
          </Button>
          <Button variant="outline" size="sm" onClick={discard} disabled={!dirty || saving}>
            Discard
          </Button>
          <Button
            size="sm"
            onClick={() => onSave(tiles)}
            disabled={!dirty || saving || tiles.length === 0}
          >
            <Check size={15} />
            {saving ? "Saving…" : "Save layout"}
          </Button>
        </div>
      </div>

      {/* One frame around the working area: a seamless canvas (widgets sit on the
          surface, no inner card) and the tile inspector, split by its border. */}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: background-deselect is a pointer affordance — keyboard users press Esc. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: same — Esc is handled above. */}
        <div
          ref={canvasBoxRef}
          onClick={(e) => {
            if (selectedId && !(e.target as HTMLElement).closest(".react-grid-item"))
              setSelectedId(null)
          }}
          className="flex min-w-0 flex-1 flex-col overflow-y-auto p-3"
        >
          {tiles.length === 0 ? (
            <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
              <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <SlidersHorizontal size={20} />
              </div>
              <p className="max-w-sm text-sm text-balance text-muted-foreground">
                Add a tile, or start from a template.
              </p>
            </div>
          ) : (
            <MeasuredGrid
              layout={layout}
              minHeight={canvasHeight}
              onStop={applyLayout}
              onDragStart={setSelectedId}
            >
              {tiles.map((t) => (
                <div key={t.id}>
                  <div className="pointer-events-none h-full select-none">
                    <SchematicTile contents={t.contents} selected={t.id === selectedId} />
                  </div>
                </div>
              ))}
            </MeasuredGrid>
          )}
        </div>
        <div className="w-px shrink-0 bg-border" />
        <aside className="flex w-72 shrink-0 flex-col overflow-y-auto p-4">
          {selected ? (
            <TileInspector
              tile={selected}
              caps={caps}
              onChange={(contents) => setContents(selected.id, contents)}
              onRemoveTile={() => removeTile(selected.id)}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <SlidersHorizontal size={18} />
              </div>
              <p className="text-sm font-medium text-foreground">No tile selected</p>
              <p className="max-w-[220px] text-xs text-balance text-muted-foreground">
                Select a tile on the canvas to edit its contents.
              </p>
            </div>
          )}
        </aside>
      </div>

      {galleryOpen && (
        <TileGallery caps={caps} onPick={addTile} onClose={() => setGalleryOpen(false)} />
      )}
    </div>
  )
}
