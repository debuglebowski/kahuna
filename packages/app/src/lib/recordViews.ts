import type { RecordViewPrefsBody } from "@kahunalabs/contract"
import { useMutation, useQuery } from "@tanstack/react-query"
import { api } from "./api"
import { queryClient } from "./queryClient"

/** Content kinds a record-version tile can show (keys of TILE_CONTENTS). */
const TILE_CONTENT_KEYS = [
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

export interface ConceptCaps {
  readonly versioned: boolean
  /** Concept has rich text fields — gates the `document` content. */
  readonly hasDocuments: boolean
}

const EMPTY_PREFS: RecordViewPrefsBody = { defaultView: null, byConcept: {}, customByConcept: {} }

/** The caller's saved view prefs (DB-backed, one row per org+user). */
export function useRecordViewPrefs() {
  const q = useQuery({
    queryKey: ["instanceViewPrefs"],
    queryFn: () => api.getRecordViewPrefs(),
  })
  const update = useMutation({
    mutationFn: (body: RecordViewPrefsBody) => api.updateRecordViewPrefs(body),
    onSuccess: (d) => queryClient.setQueryData(["instanceViewPrefs"], d),
  })
  return { body: q.data?.body ?? EMPTY_PREFS, loaded: !q.isLoading, update }
}
