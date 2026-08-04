import { useMutation, useQuery } from "@tanstack/react-query"
import type { Concept, InstanceViewPrefsBody, InstanceViewTile } from "../../rpc/contract"
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
  "graph",
  "labels",
  "versions",
  "notes",
  "tasks",
  "files",
  "activity",
  "mentions",
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

const ANNOTATIONS: ReadonlyArray<TileContentKey> = ["notes", "tasks", "files", "activity"]

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
        contents: [
          "details",
          "document",
          "connected",
          "graph",
          "labels",
          "versions",
          ...ANNOTATIONS,
        ],
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

/** The built-in default layout, used when a concept defines no layout of its own. */
export const DEFAULT_VIEW: InstanceViewDef = INSTANCE_VIEWS[0]!

const contentKeys = new Set<string>(TILE_CONTENT_KEYS)

/** A stored tile, made renderable: unknown content keys (from a newer build)
 *  are dropped, coords clamped to the 12-col grid, empty tiles removed. */
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

/** The layout to render for this concept's instances: its org-wide default
 *  layout (set in concept settings) if any tiles survive sanitizing, else the
 *  built-in default preset. The canvas still prunes contents the concept can't
 *  show (e.g. versions when versioning is off), so a stale saved layout reflows
 *  rather than leaves holes. */
export const conceptInstanceView = (concept: Concept): InstanceViewDef => {
  const tiles = sanitizeTiles(concept.instanceView?.tiles ?? [])
  return tiles.length > 0 ? { key: "concept", name: "Layout", tiles: () => tiles } : DEFAULT_VIEW
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
