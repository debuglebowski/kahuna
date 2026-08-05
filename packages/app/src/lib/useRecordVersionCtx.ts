import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import type { RecordVersionCtx } from "../components/recordVersion/types"
import { useFullOrg, useIsAdmin } from "../pages/settings/SettingsLayout"
import { api } from "./api"
import { useSession } from "./auth-client"
import { KEY, recordDetail, useRegisterCollection } from "./collections"
import { canEditVersion } from "./editability"

/**
 * Assemble the full {@link InstanceCtx} for one record — the bundle every
 * record version-detail panel reads. Shared by the record detail page and the record
 * dashboard editor's sample preview, so the assembly lives in exactly one place.
 * Returns `{ ctx: null, loading }` until the live detail collection resolves;
 * `id === ""` yields a null ctx (the hooks still run — never call conditionally).
 */
export function useRecordVersionCtx(id: string): {
  ctx: RecordVersionCtx | null
  loading: boolean
} {
  const collection = recordDetail(id)
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

  const { recordVersion, concept, fields, inboundRelationFields, related, staticLabels, labels } =
    detail
  const relationFields = fields.filter((f) => f.kind === "relation")
  const editable = canEditVersion(concept, recordVersion)
  const ctx: RecordVersionCtx = {
    recordVersion,
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
