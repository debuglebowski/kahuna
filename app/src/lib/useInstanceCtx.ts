import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import type { InstanceCtx } from "../components/instance/types"
import { useFullOrg, useIsAdmin } from "../pages/settings/SettingsLayout"
import { api } from "./api"
import { useSession } from "./auth-client"
import { instanceDetail, KEY, useRegisterCollection } from "./collections"
import { canEditVersion } from "./editability"

/**
 * Assemble the full {@link InstanceCtx} for one record — the bundle every
 * instance-detail panel reads. Shared by the record detail page and the record
 * dashboard editor's sample preview, so the assembly lives in exactly one place.
 * Returns `{ ctx: null, loading }` until the live detail collection resolves;
 * `id === ""` yields a null ctx (the hooks still run — never call conditionally).
 */
export function useInstanceCtx(id: string): { ctx: InstanceCtx | null; loading: boolean } {
  const collection = instanceDetail(id)
  useRegisterCollection(KEY.detail(id), collection)
  const detailQ = useLiveQuery(
    (q) => (id ? q.from({ d: collection }) : undefined),
    [id, collection],
  )
  const { data: session } = useSession()
  const org = useFullOrg()
  const { admin } = useIsAdmin()
  const allConcepts = useQuery({ queryKey: ["concepts"], queryFn: () => api.listConcepts() })

  const detail = detailQ.data?.[0]
  if (!id || detailQ.isLoading || !detail) return { ctx: null, loading: detailQ.isLoading }

  const { instance, concept, fields, inboundRelationFields, related, staticLabels, labels } = detail
  const relationFields = fields.filter((f) => f.kind === "relation")
  const editable = canEditVersion(concept, instance)
  const ctx: InstanceCtx = {
    instance,
    concept,
    fields,
    related,
    staticLabels,
    ownLabels: labels,
    relationFields,
    inboundRelationFields,
    editable,
    admin,
    myUserId: session?.user.id,
    members: org.data?.members ?? [],
    concepts: allConcepts.data ?? [],
    refetch: () => collection.utils.refetch(),
  }
  return { ctx, loading: false }
}
