import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArchiveRestore, Plus, Search, SlidersHorizontal, Trash2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { FilterChips, FilterTrigger } from "../components/FilterBar"
import { EditableCell, isInlineEditable } from "../components/InlineCellEditor"
import { usePageChrome } from "../components/Layout"
import { Button, Card, ConfirmDialog, IconButton, Input, Modal, Spinner } from "../components/ui"
import { api, type Instance, type SidebarCondition } from "../lib/api"
import { useSession } from "../lib/auth-client"
import {
  conceptsCollection,
  instancesByConcept,
  KEY,
  useRegisterCollection,
} from "../lib/collections"
import { type ConditionMatch, matchInstance } from "../lib/conditions"
import { FieldValueCell } from "../lib/fieldDisplay"
import { cn, showValue } from "../lib/utils"
import { InstanceForm } from "./InstanceForm"
import { isAdminRole, useFullOrg } from "./settings/SettingsLayout"

/** Generic instance browser for a single concept (filter + click-to-sort). */
export function ConceptView() {
  usePageChrome({ fullWidth: true }) // wide table
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const [filter, setFilter] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [asc, setAsc] = useState(true)

  // Advanced filters live in the URL (`f` = conditions JSON, `fm` = any) so a
  // filtered list is shareable/back-button friendly and survives a reload.
  const [searchParams, setSearchParams] = useSearchParams()
  const conditions = useMemo<SidebarCondition[]>(() => {
    const raw = searchParams.get("f")
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (c): c is SidebarCondition =>
          !!c && typeof c === "object" && typeof c.field === "string" && typeof c.op === "string",
      )
    } catch {
      return []
    }
  }, [searchParams])
  const match: ConditionMatch = searchParams.get("fm") === "any" ? "any" : "all"
  const setFilters = (conds: SidebarCondition[], m: ConditionMatch) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (conds.length > 0) next.set("f", JSON.stringify(conds))
        else next.delete("f")
        if (m === "any" && conds.length > 0) next.set("fm", "any")
        else next.delete("fm")
        return next
      },
      { replace: true },
    )

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
  const labelsQ = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
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

  // Quick edit: inline-edit cells in the list, sticky per concept. It's a mode
  // (not a one-off pref) so it gets an active cue in the toolbar and suppresses
  // row-click→detail — the # cell opens detail instead.
  const [quickEdit, setQuickEdit] = useState(false)
  useEffect(() => {
    setQuickEdit(localStorage.getItem(`kqe:${id}`) === "1")
  }, [id])
  const toggleQuickEdit = (v: boolean) => {
    setQuickEdit(v)
    try {
      localStorage.setItem(`kqe:${id}`, v ? "1" : "0")
    } catch {
      // ignore (private mode / storage disabled)
    }
  }
  // One field saved per edit; refetch (success or fail) reconciles value + version.
  const onSaveCell = async (inst: Instance, fieldId: string, value: unknown) => {
    try {
      await api.updateInstance(inst.id, inst.version, { [fieldId]: value })
    } finally {
      collection.utils.refetch()
    }
  }

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

  const me = session?.user.id ?? null
  const rows = useMemo(() => {
    let r = [...(instances.data ?? [])]
    if (conditions.length > 0) r = r.filter((i) => matchInstance(i, conditions, { match, me }))
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
  }, [instances.data, conditions, match, me, filter, sortKey, asc])

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">{name}</h2>
          <div className="flex items-center gap-1.5">
            {searchOpen ? (
              <Input
                autoFocus
                placeholder="Search…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onBlur={() => {
                  if (!filter) setSearchOpen(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setFilter("")
                    setSearchOpen(false)
                  }
                }}
                className="h-8 w-44"
              />
            ) : (
              <IconButton aria-label="Search" onClick={() => setSearchOpen(true)}>
                <Search size={15} />
              </IconButton>
            )}
            <FilterTrigger
              conceptId={id}
              fields={columns}
              labels={labelsQ.data ?? []}
              instances={instances.data ?? []}
              conditions={conditions}
              match={match}
              onChange={setFilters}
            />
            <Popover>
              <PopoverTrigger asChild>
                <IconButton
                  aria-label="Display options"
                  className={cn(quickEdit && "text-primary ring-1 ring-primary/40")}
                >
                  <SlidersHorizontal size={15} />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-3">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Display
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="display-show-archived"
                    checked={showArchived}
                    onCheckedChange={(v) => setShowArchived(v === true)}
                  />
                  <label
                    htmlFor="display-show-archived"
                    className="cursor-pointer text-sm text-foreground"
                  >
                    Show archived
                  </label>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Checkbox
                    id="display-quick-edit"
                    checked={quickEdit}
                    onCheckedChange={(v) => toggleQuickEdit(v === true)}
                  />
                  <label
                    htmlFor="display-quick-edit"
                    className="cursor-pointer text-sm text-foreground"
                  >
                    Quick edit
                  </label>
                </div>
              </PopoverContent>
            </Popover>
            <Button onClick={() => setAdding(true)} className="ml-1.5">
              <Plus size={15} />
              Create
            </Button>
          </div>
        </div>

        <FilterChips
          conceptId={id}
          fields={columns}
          labels={labelsQ.data ?? []}
          instances={instances.data ?? []}
          conditions={conditions}
          match={match}
          onChange={setFilters}
        />

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
                    className={cn(!quickEdit && "cursor-pointer")}
                    onClick={quickEdit ? undefined : () => navigate(`/instances/${r.id}`)}
                  >
                    <TableCell className="px-6 tabular-nums text-muted-foreground">
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
                      <TableCell key={c.id} className="px-6 text-foreground">
                        {quickEdit && isInlineEditable(c) ? (
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
