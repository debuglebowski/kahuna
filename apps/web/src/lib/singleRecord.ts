/**
 * Resolving a single-record concept to its one record.
 *
 * A single-record concept holds exactly ONE record, so it can be addressed
 * without an instance id — by slug at `/c/<slug>`, or by concept id from a widget
 * bound to "the record". Both need the same two-step resolution, which is what
 * lives here.
 *
 * The instance id is NOT derivable client-side: for a versioned concept the record
 * is a lineage whose head moves on every publish, and its first version is a draft
 * that no head-only list returns. So the id always comes from the server's
 * `getSingleRecord` (which uses `singleRecordOf`, not `listInstances[0]`).
 */

import { useLiveQuery } from "@tanstack/react-db"
import type { Concept, InstanceDetail } from "../../rpc/contract"
import { KEY, singleRecordOfConcept, useRegisterCollection } from "./collections"

/**
 * The single record of `conceptId`, as the same `InstanceDetail` the ordinary
 * record page renders. `conceptId` may be `""` (nothing to resolve yet) — the hook
 * stays mounted and reports `loading: false` with no detail, so callers don't need
 * a conditional hook.
 *
 * `detail` is undefined while loading AND when the concept has no record. The
 * second case shouldn't happen while the flag is on; `loading` distinguishes them
 * so the caller can show a fault rather than an eternal spinner.
 */
export function useSingleRecord(conceptId: string): {
  readonly detail: InstanceDetail | undefined
  readonly instanceId: string | null
  readonly loading: boolean
  readonly refetch: () => void
} {
  const collection = singleRecordOfConcept(conceptId)
  useRegisterCollection(KEY.singleRecord(conceptId), collection)
  const q = useLiveQuery(
    (b) => (conceptId ? b.from({ d: collection }) : undefined),
    [conceptId, collection],
  )
  const detail = q.data?.[0]
  return {
    detail,
    instanceId: detail?.instance.id ?? null,
    loading: !!conceptId && q.isLoading,
    refetch: () => void collection.utils.refetch(),
  }
}

/**
 * Find the single-record concept a `/c/<slug>` URL names. Resolved client-side
 * from the already-cached concept list rather than by a slug RPC — the list is
 * loaded on every page anyway, and one fewer round trip means the record's own
 * fetch starts a tick sooner.
 *
 * Returns undefined both while the list is still loading and when no concept
 * matches; callers check `loaded` to tell those apart. A slug that resolves to a
 * concept which is archived, managed, or not single-record is deliberately NOT
 * returned — those have no `/c/` address, so the route should 404 rather than
 * render a page that can't hold together.
 */
export const conceptBySlug = (
  concepts: ReadonlyArray<Concept> | undefined,
  slug: string,
): Concept | undefined => {
  const c = concepts?.find((x) => x.slug === slug)
  if (!c || c.archivedAt || !c.singleRecord) return undefined
  return c
}
