import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { Button, Card, Input, Modal, Spinner } from "../components/ui"
import { api } from "../lib/api"
import {
  conceptsCollection,
  instancesByConcept,
  KEY,
  useRegisterCollection,
} from "../lib/collections"
import { showValue } from "../lib/utils"
import { InstanceForm } from "./InstanceForm"

/** Generic instance browser for a single concept (filter + click-to-sort). */
export function ConceptView() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const [filter, setFilter] = useState("")
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [asc, setAsc] = useState(true)

  // Resolve the display name from the (live) concepts collection so a rename
  // reflects immediately while the id-based route stays stable.
  const { data: concepts } = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  const name = concepts?.find((c) => c.id === id)?.name ?? ""

  const collection = instancesByConcept(id)
  useRegisterCollection(KEY.instances(id), collection)
  const instances = useLiveQuery(
    (q) => (id ? q.from({ i: collection }) : undefined),
    [id, collection],
  )

  // Field defs drive the create form; loaded lazily when the user opens it.
  const [adding, setAdding] = useState(false)
  const fields = useQuery({
    queryKey: ["fields", id],
    queryFn: () => api.listFields(id),
    enabled: !!id && adding,
  })
  const create = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.createInstance(id, values),
    onSuccess: () => {
      setAdding(false)
      collection.utils.refetch()
    },
  })
  const closeModal = () => {
    setAdding(false)
    create.reset()
  }

  const columns = useMemo(() => {
    const keys = new Set<string>()
    for (const i of instances.data ?? []) for (const k of Object.keys(i.state)) keys.add(k)
    return [...keys]
  }, [instances.data])

  const rows = useMemo(() => {
    let r = [...(instances.data ?? [])]
    if (filter) {
      const f = filter.toLowerCase()
      r = r.filter((i) => JSON.stringify(i.state).toLowerCase().includes(f))
    }
    if (sortKey) {
      r.sort((a, b) => {
        const av = showValue(a.state[sortKey])
        const bv = showValue(b.state[sortKey])
        return asc ? av.localeCompare(bv) : bv.localeCompare(av)
      })
    }
    return r
  }, [instances.data, filter, sortKey, asc])

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">{name}</h2>
          <div className="flex items-center gap-2">
            <Input
              placeholder="filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-48"
            />
            <Button onClick={() => setAdding(true)}>+ Add {name}</Button>
          </div>
        </div>
        <Card>
          {instances.isLoading ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <div className="p-6 text-sm text-gray-400">No {name} instances yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                    {columns.map((c) => (
                      <th
                        key={c}
                        className="cursor-pointer px-4 py-2"
                        onClick={() => {
                          if (sortKey === c) setAsc(!asc)
                          else {
                            setSortKey(c)
                            setAsc(true)
                          }
                        }}
                      >
                        {c}
                        {sortKey === c ? (asc ? " ▲" : " ▼") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="cursor-pointer border-b border-gray-50 hover:bg-gray-50"
                      onClick={() => navigate(`/instances/${r.id}`)}
                    >
                      {columns.map((c) => (
                        <td key={c} className="px-4 py-2 text-gray-700">
                          {showValue(r.state[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {adding && (
        <Modal title={`New ${name}`} onClose={closeModal}>
          {fields.isLoading ? (
            <Spinner />
          ) : (
            <InstanceForm
              fields={fields.data ?? []}
              onSubmit={(v) => create.mutate(v)}
              onCancel={closeModal}
              pending={create.isPending}
            />
          )}
          {create.error && (
            <p className="mt-3 text-sm text-red-600">
              {(create.error as { message?: string }).message ?? "Could not create."}
            </p>
          )}
        </Modal>
      )}
    </>
  )
}
