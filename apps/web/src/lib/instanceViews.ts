import { useMutation, useQuery } from "@tanstack/react-query"
import type { InstanceViewPrefsBody, InstanceViewTile } from "../../rpc/contract"
import { api } from "./api"
import { queryClient } from "./queryClient"

/**
 * Instance-detail views: fixed preset layouts over a shared content catalog.
 * A view is a 12-column grid of tiles; a tile holds one or more contents —
 * two or more render as tabs (so anything tileable is also tabbable). Rows
 * auto-size to content; `y`/`h` order tiles and keep the data shape
 * grid-editor-compatible for later. Presets take the concept's capabilities
 * and re-flow (rather than leave holes) when versioning is off.
 */

export const TILE_CONTENT_KEYS = [
  "details",
  "document",
  "connected",
  "labels",
  "versions",
  "notes",
  "tasks",
  "activity",
] as const
export type TileContentKey = (typeof TILE_CONTENT_KEYS)[number]

export interface ViewTile {
  readonly id: string
  readonly contents: ReadonlyArray<TileContentKey>
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface ConceptCaps {
  readonly versioned: boolean
  /** Concept has rich text fields — presets carve out a document tile. */
  readonly hasDocuments: boolean
}

export interface InstanceViewDef {
  readonly key: string
  readonly name: string
  readonly tiles: (caps: ConceptCaps) => ViewTile[]
}

const ANNOTATIONS: ReadonlyArray<TileContentKey> = ["notes", "tasks", "activity"]

export const INSTANCE_VIEWS: ReadonlyArray<InstanceViewDef> = [
  {
    key: "metadata-rail",
    name: "Metadata rail",
    tiles: ({ versioned, hasDocuments }) => [
      { id: "details", contents: ["details"], x: 0, y: 0, w: 8, h: 4 },
      ...(hasDocuments
        ? [{ id: "document", contents: ["document" as const], x: 0, y: 4, w: 8, h: 4 }]
        : []),
      { id: "annotations", contents: ANNOTATIONS, x: 0, y: hasDocuments ? 8 : 4, w: 8, h: 5 },
      { id: "labels", contents: ["labels"], x: 8, y: 0, w: 4, h: 2 },
      { id: "connected", contents: ["connected"], x: 8, y: 2, w: 4, h: 2 },
      ...(versioned
        ? [{ id: "versions", contents: ["versions" as const], x: 8, y: 4, w: 4, h: 5 }]
        : []),
    ],
  },
  {
    key: "full-tabs",
    name: "Tabs",
    // `document` rides along always — the runtime `available()` check prunes
    // the tab on concepts without rich text fields (tile survives).
    tiles: () => [
      {
        id: "all",
        contents: ["details", "document", "connected", "labels", "versions", ...ANNOTATIONS],
        x: 0,
        y: 0,
        w: 12,
        h: 9,
      },
    ],
  },
  {
    key: "three-pane",
    name: "Three pane",
    tiles: ({ versioned, hasDocuments }) => {
      const main = (x: number, w: number): ViewTile[] => [
        { id: "details", contents: ["details"], x, y: 0, w, h: 4 },
        ...(hasDocuments
          ? [{ id: "document", contents: ["document" as const], x, y: 4, w, h: 4 }]
          : []),
        { id: "annotations", contents: ANNOTATIONS, x, y: hasDocuments ? 8 : 4, w, h: 5 },
      ]
      return versioned
        ? [
            { id: "versions", contents: ["versions"], x: 0, y: 0, w: 3, h: 9 },
            ...main(3, 6),
            { id: "connected", contents: ["connected"], x: 9, y: 0, w: 3, h: 5 },
            { id: "labels", contents: ["labels"], x: 9, y: 5, w: 3, h: 4 },
          ]
        : [
            ...main(0, 9),
            { id: "connected", contents: ["connected"], x: 9, y: 0, w: 3, h: 5 },
            { id: "labels", contents: ["labels"], x: 9, y: 5, w: 3, h: 4 },
          ]
    },
  },
  {
    key: "crm-split",
    name: "Workstream split",
    // `document` tabs with details (pruned at runtime when absent) — the left
    // rail is already tall and a dedicated tile would push workstream down.
    tiles: ({ versioned }) => [
      { id: "details", contents: ["details", "document"], x: 0, y: 0, w: 5, h: 3 },
      { id: "labels", contents: ["labels"], x: 0, y: 3, w: 5, h: 2 },
      { id: "connected", contents: ["connected"], x: 0, y: 5, w: 5, h: 3 },
      ...(versioned
        ? [{ id: "versions", contents: ["versions" as const], x: 0, y: 8, w: 5, h: 3 }]
        : []),
      { id: "annotations", contents: ANNOTATIONS, x: 5, y: 0, w: 7, h: versioned ? 11 : 8 },
    ],
  },
  {
    key: "document",
    name: "Document",
    tiles: ({ versioned, hasDocuments }) => {
      const shift = hasDocuments ? 5 : 0
      return [
        { id: "labels", contents: ["labels"], x: 0, y: 0, w: 12, h: 1 },
        { id: "details", contents: ["details"], x: 0, y: 1, w: 12, h: 4 },
        ...(hasDocuments
          ? [{ id: "document", contents: ["document" as const], x: 0, y: 5, w: 12, h: 5 }]
          : []),
        { id: "connected", contents: ["connected"], x: 0, y: 5 + shift, w: 12, h: 3 },
        { id: "annotations", contents: ANNOTATIONS, x: 0, y: 8 + shift, w: 12, h: 4 },
        ...(versioned
          ? [{ id: "versions", contents: ["versions" as const], x: 0, y: 12 + shift, w: 12, h: 3 }]
          : []),
      ]
    },
  },
]

export const DEFAULT_VIEW_KEY = INSTANCE_VIEWS[0]!.key

/** A per-concept override may name a user-edited layout instead of a preset. */
export const CUSTOM_VIEW_KEY = "custom"

const known = (k: string | null | undefined): string | null =>
  k && INSTANCE_VIEWS.some((v) => v.key === k) ? k : null

const contentKeys = new Set<string>(TILE_CONTENT_KEYS)

/** A stored custom tile, made renderable: unknown content keys (from a newer
 *  build) are dropped, coords clamped to the 12-col grid, empty tiles removed. */
export const sanitizeTiles = (tiles: ReadonlyArray<InstanceViewTile>): ViewTile[] =>
  tiles
    .map((t) => {
      const x = Math.min(Math.max(Math.round(t.x), 0), 11)
      return {
        id: t.id,
        contents: t.contents.filter((c): c is TileContentKey => contentKeys.has(c)),
        x,
        y: Math.max(Math.round(t.y), 0),
        w: Math.min(Math.max(Math.round(t.w), 1), 12 - x),
        h: Math.max(Math.round(t.h), 1),
      }
    })
    .filter((t) => t.contents.length > 0)

export const customTiles = (body: InstanceViewPrefsBody, conceptId: string): ViewTile[] =>
  sanitizeTiles(body.customByConcept[conceptId]?.tiles ?? [])

/** Per-concept override (preset or a saved custom layout) → my default →
 *  built-in. Unknown keys and empty custom layouts fall through, not break. */
export const resolveViewKey = (body: InstanceViewPrefsBody, conceptId: string): string => {
  const override = body.byConcept[conceptId]
  if (override === CUSTOM_VIEW_KEY && customTiles(body, conceptId).length > 0)
    return CUSTOM_VIEW_KEY
  return known(override) ?? known(body.defaultView) ?? DEFAULT_VIEW_KEY
}

export const viewByKey = (key: string): InstanceViewDef =>
  INSTANCE_VIEWS.find((v) => v.key === key) ?? INSTANCE_VIEWS[0]!

export const resolveView = (body: InstanceViewPrefsBody, conceptId: string): InstanceViewDef => {
  const key = resolveViewKey(body, conceptId)
  if (key === CUSTOM_VIEW_KEY) {
    const tiles = customTiles(body, conceptId)
    return { key, name: "Custom", tiles: () => tiles }
  }
  return viewByKey(key)
}

const EMPTY_PREFS: InstanceViewPrefsBody = { defaultView: null, byConcept: {}, customByConcept: {} }

/** The caller's saved view prefs (DB-backed, one row per org+user). */
export function useInstanceViewPrefs() {
  const q = useQuery({
    queryKey: ["instanceViewPrefs"],
    queryFn: () => api.getInstanceViewPrefs(),
  })
  const update = useMutation({
    mutationFn: (body: InstanceViewPrefsBody) => api.updateInstanceViewPrefs(body),
    onSuccess: (d) => queryClient.setQueryData(["instanceViewPrefs"], d),
  })
  return { body: q.data?.body ?? EMPTY_PREFS, loaded: !q.isLoading, update }
}
