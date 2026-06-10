import { useLiveQuery } from "@tanstack/react-db"
import { ListTodo } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Spinner } from "@/components/ui"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { Concept } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { conceptsCollection, KEY, useRegisterCollection } from "@/lib/collections"
import { useConceptData } from "@/lib/conceptData"
import { FieldValueCell } from "@/lib/fieldDisplay"
import { pickWelcome } from "@/lib/welcomeMessages"

/** The seeded Task concept, pinned by its immutable slug (survives renames). */
const TASK_SLUG = "task"

/**
 * The landing page (`/`): a random big-title greeting plus the viewer's tasks.
 * "Mine" = any user-kind field of the `task` concept contains the session user —
 * field names are decorative (state is keyed by field id), so we match the kind,
 * not a field called "assignee".
 */
export function Overview() {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const me = session?.user
  // Drawn once per visit; re-renders must not reshuffle the title.
  const [welcome] = useState(() => pickWelcome(me?.name))

  const conceptsLive = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  useRegisterCollection(KEY.concepts, conceptsCollection)
  const concepts = (conceptsLive.data ?? []) as Concept[]
  const taskConcept = concepts.find((c) => c.slug === TASK_SLUG && !c.archivedAt) ?? null

  const ids = useMemo(() => (taskConcept ? [taskConcept.id] : []), [taskConcept])
  const { instData, loaders } = useConceptData(ids)
  const data = taskConcept ? instData[taskConcept.id] : undefined

  const userFieldIds = useMemo(
    () => (data?.fields ?? []).filter((f) => f.kind === "user").map((f) => f.id),
    [data?.fields],
  )
  const mine = useMemo(() => {
    const uid = me?.id
    if (!uid) return []
    return (data?.instances ?? [])
      .filter((i) =>
        userFieldIds.some((fid) => {
          const v = i.state[fid]
          return Array.isArray(v) ? v.includes(uid) : v === uid
        }),
      )
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
  }, [data?.instances, userFieldIds, me?.id])

  // Same column model as ListWidget: the concept's scalar fields.
  const columns = useMemo(
    () => (data?.fields ?? []).filter((f) => f.kind !== "relation" && f.kind !== "file"),
    [data?.fields],
  )

  const body = () => {
    if (!taskConcept)
      return (
        <EmptyBox>No task concept in this org yet — create one in Settings → Concepts.</EmptyBox>
      )
    if (!data) return <Spinner />
    if (mine.length === 0)
      return <EmptyBox>Nothing assigned to you. Savor it while it lasts.</EmptyBox>
    return (
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c.id} className="px-3 py-2">
                  {c.name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {mine.map((r) => (
              <TableRow
                key={r.id}
                className="cursor-pointer"
                onClick={() => navigate(`/instances/${r.id}`)}
              >
                {columns.map((c) => (
                  <TableCell key={c.id} className="px-3 py-2 text-foreground">
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

  return (
    <div className="mx-auto flex min-h-[80vh] w-full max-w-2xl flex-col justify-center gap-8">
      {loaders}
      <h1 className="text-6xl leading-tight font-bold tracking-tight text-balance text-foreground">
        {welcome}
      </h1>
      <section className="space-y-3">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <ListTodo size={15} />
          My {taskConcept ? (taskConcept.pluralName ?? taskConcept.name).toLowerCase() : "tasks"}
        </h2>
        {body()}
      </section>
    </div>
  )
}

function EmptyBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[160px] items-center justify-center rounded-xl border border-dashed p-8">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  )
}
