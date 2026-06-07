import { useLiveQuery } from "@tanstack/react-db"
import { useMemo, useState } from "react"
import { Navigate, useParams } from "react-router-dom"
import { Card, CardHeader, Input, Spinner } from "../components/ui"
import { instancesByConcept, KEY, useRegisterCollection } from "../lib/collections"
import { showValue } from "../lib/utils"

/** Generic instance browser for a single concept (filter + click-to-sort). */
export function ConceptView() {
  const { name = "" } = useParams()
  const [filter, setFilter] = useState("")
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [asc, setAsc] = useState(true)

  const collection = instancesByConcept(name)
  useRegisterCollection(KEY.instances(name), collection)
  const instances = useLiveQuery(
    (q) => (name && name !== "Account" ? q.from({ i: collection }) : undefined),
    [name, collection],
  )

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

  // Account has a bespoke list + hub experience.
  if (name === "Account") return <Navigate to="/accounts" replace />

  return (
    <Card>
      <CardHeader
        title={name}
        action={
          <Input
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-48"
          />
        }
      />
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
                <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50">
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
  )
}
