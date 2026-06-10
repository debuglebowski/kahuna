import { useMemo } from "react"
import { useNavigate } from "react-router-dom"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { DashboardWidget } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import type { ConceptInstanceData } from "@/lib/conceptData"
import { FieldValueCell } from "@/lib/fieldDisplay"
import { showValue } from "@/lib/utils"
import { matchInstance } from "@/lib/widgetAggregations"

type List = Extract<DashboardWidget, { type: "list" }>

/** Instances of a concept matching the widget's filter, as a compact table.
 *  Mirrors ConceptView's column model: state is keyed by field id, so a column's
 *  header is the (renameable) field name and the cell/sort key is the stable id. */
export function ListWidget({
  widget,
  data,
}: {
  widget: List
  data: ConceptInstanceData | undefined
}) {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const me = session?.user.id ?? null
  const fields = data?.fields ?? []

  // Columns: explicit selection, else the concept's scalar fields (no relation/file).
  const columns = useMemo(() => {
    const visible = fields.filter((f) => f.kind !== "relation" && f.kind !== "file")
    return widget.columns && widget.columns.length > 0
      ? widget.columns.map((id) => visible.find((f) => f.id === id)).filter((f) => !!f)
      : visible
  }, [fields, widget.columns])

  const rows = useMemo(() => {
    let r = (data?.instances ?? []).filter((i) =>
      matchInstance(i, widget.conditions, { match: widget.match, me }),
    )
    if (widget.orderBy) {
      const key = widget.orderBy
      r = [...r].sort((a, b) => showValue(a.state[key]).localeCompare(showValue(b.state[key])))
    }
    if (widget.limit && widget.limit > 0) r = r.slice(0, widget.limit)
    return r
  }, [data?.instances, widget.conditions, widget.match, me, widget.orderBy, widget.limit])

  if (!widget.conceptId) return <p className="text-sm text-muted-foreground">Pick a concept.</p>
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No matching items.</p>

  return (
    <div className="-mx-1 h-full overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.id} className="px-3 py-1.5">
                {c.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={r.id}
              className="cursor-pointer"
              onClick={() => navigate(`/instances/${r.id}`)}
            >
              {columns.map((c) => (
                <TableCell key={c.id} className="px-3 py-1.5 text-foreground">
                  <FieldValueCell field={c} value={r.state[c.id]} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
