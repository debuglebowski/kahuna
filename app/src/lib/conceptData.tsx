import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api, type Concept, type Field, type Instance } from "./api"
import { instancesByConcept, KEY, useRegisterCollection } from "./collections"

/**
 * Shared live-data loading for surfaces that resolve against a concept's
 * instances (the dashboard canvas; later the sidebar). Each loader mounts a
 * concept's instance collection (registering it so the SSE stream refetches it)
 * plus its field defs, and pushes the loaded data up. Invisible — render the
 * loaders the hook returns, then read from `instData`.
 */

export interface ConceptInstanceData {
  readonly instances: readonly Instance[]
  readonly fields: readonly Field[]
}

function ConceptDataLoader({
  conceptId,
  onData,
}: {
  conceptId: string
  onData: (id: string, d: ConceptInstanceData) => void
}) {
  const col = instancesByConcept(conceptId)
  useRegisterCollection(KEY.instances(conceptId), col)
  const live = useLiveQuery((q) => q.from({ i: col }), [col])
  const fields = useQuery({
    queryKey: ["fields", conceptId],
    queryFn: () => api.listFields(conceptId),
    enabled: !!conceptId,
  })
  useEffect(() => {
    onData(conceptId, {
      instances: live.data ?? [],
      fields: (fields.data ?? []) as readonly Field[],
    })
  }, [conceptId, live.data, fields.data, onData])
  return null
}

/**
 * Mount the live instance collections for a set of concept ids and hand back
 * the loaded data plus the invisible loader nodes the caller must render.
 */
export function useConceptData(conceptIds: readonly string[]): {
  instData: Record<string, ConceptInstanceData>
  loaders: React.ReactNode
} {
  const [instData, setInstData] = useState<Record<string, ConceptInstanceData>>({})
  const onData = useCallback((id: string, d: ConceptInstanceData) => {
    setInstData((prev) =>
      prev[id]?.instances === d.instances && prev[id]?.fields === d.fields
        ? prev
        : { ...prev, [id]: d },
    )
  }, [])
  // Stable, deduped key so the loader set only changes when the ids change.
  const key = useMemo(() => [...new Set(conceptIds)].sort().join(","), [conceptIds])
  const ids = useMemo(() => (key ? key.split(",") : []), [key])
  const loaders = (
    <>
      {ids.map((cid) => (
        <ConceptDataLoader key={cid} conceptId={cid} onData={onData} />
      ))}
    </>
  )
  return { instData, loaders }
}

/** Concept display lookup for widget chrome. */
export const conceptIndex = (concepts: readonly Concept[]): Map<string, Concept> =>
  new Map(concepts.map((c) => [c.id, c] as const))
