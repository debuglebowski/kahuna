import { useQueries, useQuery } from "@tanstack/react-query"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge, Card, LabelChip } from "../../components/ui"
import { api, type Concept, type Field, type Label } from "../../lib/api"
import { ConceptIcon, DEFAULT_CONCEPT_ICON } from "../../lib/icons"

type Graph = Awaited<ReturnType<typeof api.getConceptGraph>>

/** Per concept: which concepts it points at, which point at it, its member fields. */
function connections(graph: Graph | undefined) {
  const out = new Map<string, Set<string>>()
  const inn = new Map<string, Set<string>>()
  const add = (m: Map<string, Set<string>>, k: string, v: string) =>
    m.set(k, (m.get(k) ?? new Set()).add(v))
  for (const e of graph?.edges ?? []) {
    add(out, e.from, e.to)
    if (e.to !== e.from) add(inn, e.to, e.from)
  }
  const members = new Map<string, string[]>()
  for (const e of graph?.userEdges ?? [])
    members.set(e.from, [...(members.get(e.from) ?? []), e.fieldName])
  return { out, inn, members }
}

const MAX_CHIPS = 3
const Dash = () => <span className="text-muted-foreground">—</span>

/** A few small chips, then "+N" (full list in the tooltip). */
function Chips({ items }: { items: ReadonlyArray<string> }) {
  if (items.length === 0) return <Dash />
  const shown = items.slice(0, MAX_CHIPS)
  const more = items.length - shown.length
  return (
    <div className="flex flex-wrap gap-1" title={items.join(", ")}>
      {shown.map((t) => (
        <span key={t} className="max-w-36 truncate rounded bg-muted px-1.5 py-0.5 text-xs">
          {t}
        </span>
      ))}
      {more > 0 && <span className="px-0.5 py-0.5 text-xs text-muted-foreground">+{more}</span>}
    </div>
  )
}

/**
 * The concepts as a table — the alternative to the graph canvas on
 * /settings/concepts. Live concepts only (archived ones have their own list
 * below). Connections come from the same `conceptGraph` query the canvas uses;
 * field counts reuse the `["fields", id]` cache other screens fill. A row opens
 * the concept editor.
 */
export function ConceptTable({
  concepts,
  onOpen,
}: {
  concepts: ReadonlyArray<Concept>
  onOpen: (conceptId: string) => void
}) {
  const graph = useQuery({ queryKey: ["conceptGraph"], queryFn: () => api.getConceptGraph() })
  const labels = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
  const rows = [...concepts].sort((a, b) => a.name.localeCompare(b.name))
  const fieldQs = useQueries({
    queries: rows.map((c) => ({
      queryKey: ["fields", c.id],
      queryFn: () => api.listFields(c.id),
    })),
  })
  const fieldsOf = new Map(rows.map((c, i) => [c.id, fieldQs[i]?.data as Field[] | undefined]))

  const { out, inn, members } = connections(graph.data)
  const nameOf = new Map((graph.data?.nodes ?? []).map((n) => [n.id, n.name]))
  const names = (ids: Set<string> | undefined) =>
    [...(ids ?? [])].map((id) => nameOf.get(id) ?? "?").sort((a, b) => a.localeCompare(b))
  const labelById = new Map((labels.data ?? []).map((l) => [l.id, l]))

  return (
    <Card className="h-full overflow-hidden">
      <Table containerClassName="h-full">
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow>
            <TableHead className="pl-6">Concept</TableHead>
            <TableHead className="w-24 text-right">Fields</TableHead>
            <TableHead className="w-24 text-right">Records</TableHead>
            <TableHead title="Concepts this one's relation fields point at">Links to</TableHead>
            <TableHead title="Concepts with relation fields pointing here">Linked from</TableHead>
            <TableHead title="Fields that point at org members">Member fields</TableHead>
            <TableHead title="Labels every record gets (static) or starts with (default)">
              Labels
            </TableHead>
            <TableHead className="pr-6">Type</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                No concepts match.
              </TableCell>
            </TableRow>
          )}
          {rows.map((c) => {
            const fields = fieldsOf.get(c.id)
            const required = fields?.filter((f) => f.config?.requirement === "required").length ?? 0
            const conceptLabels = [...new Set([...c.staticLabelIds, ...c.defaultLabelIds])]
              .map((id) => labelById.get(id))
              .filter((l): l is Label => !!l)
            return (
              <TableRow
                key={c.id}
                className="cursor-pointer align-top"
                onClick={() => onOpen(c.id)}
              >
                <TableCell className="pl-6">
                  <button
                    type="button"
                    // The row is clickable; the name is the keyboard-reachable target.
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpen(c.id)
                    }}
                    className="flex min-w-0 items-start gap-2.5 text-left"
                  >
                    <span className="mt-0.5 flex w-5 shrink-0 justify-center text-muted-foreground">
                      <ConceptIcon value={c.icon || DEFAULT_CONCEPT_ICON} size={16} />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        {c.color && (
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ background: c.color }}
                            aria-hidden
                          />
                        )}
                        <span className="truncate font-medium text-foreground">{c.name}</span>
                      </span>
                      {c.description && (
                        <span className="block max-w-80 truncate text-xs text-muted-foreground">
                          {c.description}
                        </span>
                      )}
                    </span>
                  </button>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fields ? (
                    <>
                      {fields.length}
                      {required > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          {required} required
                        </span>
                      )}
                    </>
                  ) : (
                    <Dash />
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {c.recordCount ? c.recordCount.toLocaleString() : <Dash />}
                </TableCell>
                <TableCell>
                  <Chips items={names(out.get(c.id))} />
                </TableCell>
                <TableCell>
                  <Chips items={names(inn.get(c.id))} />
                </TableCell>
                <TableCell>
                  <Chips items={members.get(c.id) ?? []} />
                </TableCell>
                <TableCell>
                  {conceptLabels.length === 0 ? (
                    <Dash />
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {conceptLabels.map((l) => (
                        <LabelChip key={l.id} color={l.color}>
                          {l.name}
                        </LabelChip>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="pr-6">
                  <div className="flex flex-wrap gap-1.5">
                    {c.managedBy && <Badge tone="blue">Integration</Badge>}
                    {c.singleRecord && <Badge>Single record</Badge>}
                    {c.versioningEnabled && <Badge>Versioned</Badge>}
                    {!c.managedBy && !c.singleRecord && !c.versioningEnabled && <Dash />}
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}
