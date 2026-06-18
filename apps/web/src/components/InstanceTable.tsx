import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { Field, Instance } from "@/lib/api"
import { FieldValueCell } from "@/lib/fieldDisplay"
import { cn, showValue } from "@/lib/utils"
import { EditableCell, isInlineEditable } from "./InlineCellEditor"

/**
 * The instance table shared by the concept page and the dashboard list widget:
 * field-driven columns with click-to-sort headers, row click → detail page, and
 * quick-edit mode (inline cells; the # cell becomes the detail link instead).
 * Sort state is owned here; callers pass rows already filtered to taste.
 */
export function InstanceTable({
  columns,
  rows,
  quickEdit = false,
  onSaveCell,
  defaultSortKey = null,
  dense = false,
  fill = false,
}: {
  columns: Field[]
  rows: Instance[]
  quickEdit?: boolean
  onSaveCell?: (inst: Instance, fieldId: string, value: unknown) => Promise<void>
  defaultSortKey?: string | null
  /** Tighter cell padding for embedded surfaces (widgets). */
  dense?: boolean
  /** Fill the scroll container to the parent's height so the (empty space and)
   *  horizontal scrollbar sit at the bottom, not under the last row. Rows keep
   *  their natural height (dashboard list widget). */
  fill?: boolean
}) {
  const navigate = useNavigate()
  const [sortKey, setSortKey] = useState<string | null>(defaultSortKey)
  const [asc, setAsc] = useState(true)

  const sorted = useMemo(() => {
    if (!sortKey) return rows
    return [...rows].sort((a, b) => {
      const av = showValue(a.state[sortKey])
      const bv = showValue(b.state[sortKey])
      return asc ? av.localeCompare(bv) : bv.localeCompare(av)
    })
  }, [rows, sortKey, asc])

  const pad = dense ? "px-3" : "px-6"

  return (
    <Table containerClassName={cn(fill && "h-full")}>
      <TableHeader>
        <TableRow>
          <TableHead className={cn("w-12 text-muted-foreground", pad)}>#</TableHead>
          {columns.map((c) => (
            <TableHead
              key={c.id}
              className={cn("cursor-pointer", pad)}
              onClick={() => {
                if (sortKey === c.id) setAsc(!asc)
                else {
                  setSortKey(c.id)
                  setAsc(true)
                }
              }}
            >
              {c.name}
              {sortKey === c.id ? (asc ? " ▲" : " ▼") : ""}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((r, i) => (
          <TableRow
            key={r.id}
            className={cn(!quickEdit && "cursor-pointer")}
            onClick={quickEdit ? undefined : () => navigate(`/instances/${r.id}`)}
          >
            <TableCell className={cn("tabular-nums text-muted-foreground", pad)}>
              {quickEdit ? (
                <button
                  type="button"
                  title="Open"
                  className="tabular-nums hover:text-foreground hover:underline"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/instances/${r.id}`)
                  }}
                >
                  {i + 1}
                </button>
              ) : (
                i + 1
              )}
            </TableCell>
            {columns.map((c) => (
              <TableCell key={c.id} className={cn("text-foreground", pad)}>
                {quickEdit && onSaveCell && isInlineEditable(c) ? (
                  <EditableCell field={c} instance={r} onSave={onSaveCell} />
                ) : (
                  <FieldValueCell field={c} value={r.state[c.id]} />
                )}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
