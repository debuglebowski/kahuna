import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArchiveRestore, Plus, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button, Card, ConfirmDialog, IconButton, Input, Modal, Spinner } from "../components/ui"
import { api, type Instance } from "../lib/api"
import { useSession } from "../lib/auth-client"
import {
  conceptsCollection,
  instancesByConcept,
  KEY,
  useRegisterCollection,
} from "../lib/collections"
import { FieldValueCell } from "../lib/fieldDisplay"
import { showValue } from "../lib/utils"
import { InstanceForm } from "./InstanceForm"
import { isAdminRole, useFullOrg } from "./settings/SettingsLayout"

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
  const concept = concepts?.find((c) => c.id === id)
  const name = concept?.name ?? ""

  const collection = instancesByConcept(id)
  useRegisterCollection(KEY.instances(id), collection)
  const instances = useLiveQuery(
    (q) => (id ? q.from({ i: collection }) : undefined),
    [id, collection],
  )

  // Field defs drive both the table columns (id→name) and the create form.
  const [adding, setAdding] = useState(false)
  const fields = useQuery({
    queryKey: ["fields", id],
    queryFn: () => api.listFields(id),
    enabled: !!id,
  })
  const create = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.createInstance(id, values),
    onSuccess: (created) => {
      setAdding(false)
      collection.utils.refetch()
      // On a versioned concept the new item is an unpublished draft — invisible
      // in this head-only list — so go straight to its detail page to edit/publish.
      if (concept?.versioningEnabled) navigate(`/instances/${created.id}`)
    },
  })

  // A hard delete is admin-only (archive/restore are ordinary item writes).
  const qc = useQueryClient()
  const { data: session } = useSession()
  const org = useFullOrg()
  const myRole = org.data?.members?.find((m) => m.userId === session?.user.id)?.role
  const admin = isAdminRole(myRole)

  const [showArchived, setShowArchived] = useState(false)
  // Delete pops a confirm dialog; restore is immediate.
  const [dialog, setDialog] = useState<{ kind: "delete"; inst: Instance } | null>(null)

  // Archived items load on demand, separate from the live collection.
  const archivedQ = useQuery({
    queryKey: ["instances", id, "archived"],
    queryFn: () => api.listInstances(id, { includeArchived: true }),
    enabled: !!id && showArchived,
  })
  const archivedRows = (archivedQ.data ?? []).filter((i) => i.archivedAt)
  const refetchAll = () => {
    collection.utils.refetch()
    qc.invalidateQueries({ queryKey: ["instances", id, "archived"] })
  }

  const restoreInst = useMutation({
    mutationFn: (i: Instance) => api.restoreInstance(i.id, i.version),
    onSuccess: refetchAll,
  })
  const delInst = useMutation({
    mutationFn: (i: Instance) => api.deleteInstance(i.id),
    onSuccess: () => {
      setDialog(null)
      refetchAll()
    },
  })

  const closeModal = () => {
    setAdding(false)
    create.reset()
  }

  // Columns come from the concept's field defs (state is keyed by field id):
  // header = the renameable name, cell/sort key = the stable id. Relation/file
  // values don't live in state, so they're not columns.
  const columns = useMemo(
    () => (fields.data ?? []).filter((f) => f.kind !== "relation" && f.kind !== "file"),
    [fields.data],
  )

  // A human-ish label for a row: its first non-empty visible column, else a fallback.
  const rowLabel = (state: Record<string, unknown>) => {
    for (const c of columns) {
      const v = state[c.id]
      if (v !== undefined && v !== null && v !== "") return showValue(v)
    }
    return "this item"
  }

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
          <h2 className="text-2xl font-bold tracking-tight text-foreground">{name}</h2>
          <div className="flex items-center gap-3">
            <Button
              variant="link"
              onClick={() => setShowArchived((v) => !v)}
              className="h-auto whitespace-nowrap p-0 text-xs font-normal text-muted-foreground hover:text-foreground"
            >
              {showArchived ? "Hide" : "Show"} archived
            </Button>
            <Input
              placeholder="filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-48"
            />
            <Button onClick={() => setAdding(true)}>
              <Plus size={15} />
              Create
            </Button>
          </div>
        </div>

        <Card>
          {instances.isLoading ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No {name} instances yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 px-6 text-muted-foreground">#</TableHead>
                  {columns.map((c) => (
                    <TableHead
                      key={c.id}
                      className="cursor-pointer px-6"
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
                {rows.map((r, i) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/instances/${r.id}`)}
                  >
                    <TableCell className="px-6 tabular-nums text-muted-foreground">
                      {i + 1}
                    </TableCell>
                    {columns.map((c) => (
                      <TableCell key={c.id} className="px-6 text-foreground">
                        <FieldValueCell field={c} value={r.state[c.id]} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        {showArchived && (
          <Card>
            <div className="border-b border-border px-6 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Archived{archivedQ.isFetching ? " · loading…" : ` (${archivedRows.length})`}
            </div>
            {archivedRows.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">No archived {name} items.</p>
            ) : (
              <ul className="divide-y divide-border">
                {archivedRows.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 px-6 py-2 opacity-70">
                    <span className="flex-1 truncate text-sm text-foreground">
                      {rowLabel(r.state)}
                    </span>
                    <IconButton
                      aria-label={`Restore ${rowLabel(r.state)}`}
                      disabled={restoreInst.isPending}
                      onClick={() => restoreInst.mutate(r)}
                    >
                      <ArchiveRestore size={15} />
                    </IconButton>
                    {admin && (
                      <IconButton
                        variant="danger"
                        aria-label={`Delete ${rowLabel(r.state)}`}
                        onClick={() => setDialog({ kind: "delete", inst: r })}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {restoreInst.error && (
              <p className="px-6 pb-4 text-sm text-destructive">
                {(restoreInst.error as { message?: string }).message ?? "Could not restore."}
              </p>
            )}
          </Card>
        )}
      </div>

      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete ${name}`}
          message={
            <>
              Permanently delete <strong>{rowLabel(dialog.inst.state)}</strong>? This can't be
              undone, and is refused while other items still link to it.
            </>
          }
          confirmLabel="Delete"
          confirmVariant="danger"
          pending={delInst.isPending}
          error={
            delInst.error
              ? ((delInst.error as { message?: string }).message ?? "Could not delete.")
              : undefined
          }
          onConfirm={() => delInst.mutate(dialog.inst)}
          onCancel={() => setDialog(null)}
        />
      )}

      {adding && (
        <Modal title={`New ${name}`} onClose={closeModal}>
          {fields.isLoading ? (
            <Spinner />
          ) : (
            <InstanceForm
              fields={fields.data ?? []}
              defaultLabelIds={concept?.defaultLabelIds ?? []}
              onSubmit={(v) => create.mutate(v)}
              onCancel={closeModal}
              pending={create.isPending}
            />
          )}
          {create.error && (
            <p className="mt-3 text-sm text-destructive">
              {(create.error as { message?: string }).message ?? "Could not create."}
            </p>
          )}
        </Modal>
      )}
    </>
  )
}
