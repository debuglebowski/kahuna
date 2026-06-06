import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { Card, CardHeader, Input, Select, Spinner } from "../components/ui"
import { apiGet, type Concept, type Instance } from "../lib/api"
import { showValue } from "../lib/utils"

export function Browse() {
  const concepts = useQuery({
    queryKey: ["concepts"],
    queryFn: () => apiGet<Concept[]>("/api/concepts"),
  })
  const [concept, setConcept] = useState("")
  const [filter, setFilter] = useState("")
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [asc, setAsc] = useState(true)

  const active = concept || concepts.data?.[0]?.name || ""
  const decorate = active === "Deal" ? "&decorate=1" : ""
  const instances = useQuery({
    queryKey: ["instances", active],
    enabled: !!active,
    queryFn: () =>
      apiGet<Instance[]>(`/api/instances?concept=${encodeURIComponent(active)}${decorate}`),
  })

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
    <Card>
      <CardHeader
        title="Concept browser"
        action={
          <div className="flex gap-2">
            <Select
              value={active}
              onChange={(e) => {
                setConcept(e.target.value)
                setSortKey(null)
              }}
            >
              {(concepts.data ?? []).map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Input
              placeholder="filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-48"
            />
          </div>
        }
      />
      {instances.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <div className="p-4 text-sm text-gray-400">No instances.</div>
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
