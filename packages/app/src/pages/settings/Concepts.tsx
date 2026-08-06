import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArchiveRestore, Plus, Trash2, X } from "lucide-react"
import { useState } from "react"
import {
  Navigate,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from "react-router-dom"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  IconButton,
  Input,
  Modal,
  randomPillColor,
  Spinner,
  ToggleChip,
  Toolbar,
} from "../../components/ui"
import { api } from "../../lib/api"
import { ConceptIcon, DEFAULT_CONCEPT_ICON } from "../../lib/icons"
import { ConceptEditor, msgOf } from "./ConceptEditor"
import { ConceptGraphCanvas } from "./ConceptGraphCanvas"

/** Which destructive confirm dialog is open (null = none), and on which concept.
 *  They live at the page level (not in {@link ConceptEditor}) because both the
 *  archived-concepts list (list route) and the editor (detail route) trigger
 *  them — the target id keeps them route-independent. */
type Dialog =
  | { kind: "archiveConcept"; conceptId: string }
  | { kind: "deleteConcept"; conceptId: string }
  | null

export function Concepts() {
  const { admin } = useOutletContext<{ admin: boolean }>()
  const qc = useQueryClient()
  // Fetch archived too so the settings page can manage them; the live list (and
  // graph) are derived from this. The sidebar/graph elsewhere stay live-only.
  const concepts = useQuery({
    queryKey: ["concepts", "withArchived"],
    queryFn: () => api.listConcepts({ includeArchived: true, withCounts: true }),
  })
  const archivedConcepts = concepts.data?.filter((c) => c.archivedAt) ?? []
  const navigate = useNavigate()
  // The editor is a route: /settings/concepts/:id (full-page, takes over).
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const [creatingConcept, setCreatingConcept] = useState(false)
  const [newName, setNewName] = useState("")
  const [showArchived, setShowArchived] = useState(false)
  const [filter, setFilter] = useState("")
  const [dialog, setDialog] = useState<Dialog>(null)

  // The concept a confirm dialog targets (archived-list row or the open editor).
  const target = concepts.data?.find((c) => c.id === dialog?.conceptId) ?? null

  const refetchConcepts = () => qc.invalidateQueries({ queryKey: ["concepts"] })
  // Concept names + relation fields drive the graph, so refresh it after every edit.
  const refetchGraph = () => qc.invalidateQueries({ queryKey: ["conceptGraph"] })

  /**
   * WHO CAN SEE IT, decided while naming it.
   *
   * A concept's readability is a value per (concept, role) — there is no longer a
   * column or a default underneath — so something has to choose one at creation. The
   * creation template supplies the answer, and this is the chance to differ from it
   * before anyone sees the concept at all, which is the only moment when getting it
   * wrong costs nothing.
   *
   * Only `view`, and only roles that are not full-access: the rest of what a role may
   * do comes from the template, so its write access stays consistent with everywhere
   * else, and a create dialog does not quietly become a settings screen.
   */
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.listRoles() })
  const accessDefaults = useQuery({
    queryKey: ["accessDefaults"],
    queryFn: () => api.listAccessDefaults(),
  })
  /** roleId → may view. Seeded from the template the first time the dialog opens. */
  const [access, setAccess] = useState<Record<string, boolean>>({})
  // Full-access roles are left out: they hold a blanket `*`, so "not allowed to see
  // it" is not a state they can be in, and a disabled checkbox for each would just be
  // noise on a create form.
  const scopedRoles = (roles.data ?? []).filter((r) => !r.fullAccess)
  // A deny template beats an allow one for the same role — same fold as the grid
  // (`PermissionMatrix.stateFrom`) — so a role whose default is "deny view" reads
  // as unchecked here even if it also somehow holds an allow row.
  const templateView = (roleId: string) => {
    const mine = (accessDefaults.data ?? []).filter(
      (d) => d.roleId === roleId && d.resourceType === "concept",
    )
    if (mine.some((d) => d.effect === "deny" && d.actions.includes("view"))) return false
    return mine.some((d) => d.effect === "allow" && d.actions.includes("view"))
  }
  const mayView = (roleId: string) => access[roleId] ?? templateView(roleId)

  const createConcept = useMutation({
    // New concepts start with a default color: a palette hex no live concept
    // already uses (random reuse only once all 40 are claimed).
    mutationFn: (name: string) =>
      api.createConcept(
        name,
        randomPillColor(
          (concepts.data ?? []).flatMap((c) => (c.archivedAt || !c.color ? [] : [c.color])),
        ),
        scopedRoles.map((r) => ({ roleId: r.id, view: mayView(r.id) })),
      ),
    onSuccess: (c) => {
      setCreatingConcept(false)
      setNewName("")
      setAccess({})
      refetchConcepts()
      refetchGraph()
      navigate(`/settings/concepts/${c.id}`)
    },
  })
  const submitNewConcept = () => {
    const trimmed = newName.trim()
    if (trimmed) createConcept.mutate(trimmed)
  }

  const archiveConcept = useMutation({
    mutationFn: (id: string) => api.archiveConcept(id),
    onSuccess: () => {
      setDialog(null)
      refetchConcepts()
      refetchGraph()
    },
  })
  const restoreConcept = useMutation({
    mutationFn: (id: string) => api.restoreConcept(id),
    onSuccess: () => {
      refetchConcepts()
      refetchGraph()
    },
  })
  const delConcept = useMutation({
    mutationFn: (cid: string) => api.deleteConcept(cid),
    onSuccess: () => {
      // No explicit navigate: once the concept leaves the refetched list, the
      // detail branch below misses it and <Navigate>s back to the graph — which
      // unmounts the editor (and its unsaved-guard) before the redirect fires.
      setDialog(null)
      refetchConcepts()
      refetchGraph()
    },
  })

  if (concepts.isPending) return <Spinner />

  // ?concept=<id> deep link (e.g. the record view's "Edit concept") → route form.
  const deepLink = searchParams.get("concept")
  if (deepLink && !id) return <Navigate to={`/settings/concepts/${deepLink}`} replace />

  // The find-filter narrows the archived list too (the canvas dims live ones).
  const q = filter.trim().toLowerCase()
  const archivedShown = archivedConcepts.filter((c) => c.name.toLowerCase().includes(q))

  // Archive/delete confirms — shared by the archived list (list route) and the
  // editor (detail route), so rendered alongside both.
  const conceptDialogs = (
    <>
      {dialog?.kind === "archiveConcept" && target && (
        <ConfirmDialog
          title="Archive concept"
          message={
            <>
              Archive <strong>{target.name}</strong>? It's hidden from the sidebar and lists, but
              its fields
              {target.recordCount
                ? ` and ${target.recordCount} item${target.recordCount === 1 ? "" : "s"}`
                : ""}{" "}
              are kept — you can restore it anytime.
            </>
          }
          confirmLabel="Archive"
          pending={archiveConcept.isPending}
          error={archiveConcept.error ? msgOf(archiveConcept.error) : undefined}
          onConfirm={() => archiveConcept.mutate(target.id)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "deleteConcept" && target && (
        <ConfirmDialog
          title="Delete concept"
          message={
            // A single-record concept always holds its one record, so the ordinary
            // "delete its records first" route is closed to it — the record can't be
            // deleted while the flag is on. Deleting the concept takes the record
            // with it (one transaction), so the copy says so instead of refusing.
            target.singleRecord ? (
              <>
                Permanently delete <strong>{target.name}</strong>, its fields, and its record? This
                can't be undone.
              </>
            ) : target.recordCount ? (
              <>
                <strong>{target.name}</strong> still has {target.recordCount} record
                {target.recordCount === 1 ? "" : "s"}, so it can't be deleted. Archive it (its
                records come back on restore), or delete its records first.
              </>
            ) : (
              <>
                Permanently delete <strong>{target.name}</strong> and its fields? This can't be
                undone.
              </>
            )
          }
          confirmLabel="Delete"
          confirmVariant="danger"
          secondaryLabel={target.archivedAt ? undefined : "Archive instead"}
          onSecondary={target.archivedAt ? undefined : () => archiveConcept.mutate(target.id)}
          pending={delConcept.isPending || archiveConcept.isPending}
          error={delConcept.error ? msgOf(delConcept.error) : undefined}
          onConfirm={() => delConcept.mutate(target.id)}
          onCancel={() => setDialog(null)}
        />
      )}
    </>
  )

  // Detail route (/settings/concepts/:id) — the full-page editor takes over.
  if (id) {
    const sel = concepts.data?.find((c) => c.id === id) ?? null
    if (!sel) return <Navigate to="/settings/concepts" replace />
    return (
      <>
        <ConceptEditor
          key={sel.id}
          concept={sel}
          admin={admin}
          concepts={concepts.data ?? []}
          onRequestArchive={() => setDialog({ kind: "archiveConcept", conceptId: sel.id })}
          onRequestDelete={() => setDialog({ kind: "deleteConcept", conceptId: sel.id })}
          onRestore={() => restoreConcept.mutate(sel.id)}
          restorePending={restoreConcept.isPending}
          restoreError={restoreConcept.error ? msgOf(restoreConcept.error) : undefined}
        />
        {conceptDialogs}
      </>
    )
  }

  return (
    <div className="space-y-3">
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Find concept…">
        {admin && archivedConcepts.length > 0 && (
          <ToggleChip pressed={showArchived} onPressedChange={setShowArchived}>
            Archived ({archivedConcepts.length})
          </ToggleChip>
        )}
        {admin && (
          <Button size="sm" onClick={() => setCreatingConcept(true)}>
            <Plus size={15} />
            New concept
          </Button>
        )}
      </Toolbar>

      <ConceptGraphCanvas
        selectedId={null}
        onSelect={(cid) => navigate(`/settings/concepts/${cid}`)}
        filter={filter}
      />

      {showArchived && archivedShown.length > 0 && (
        <Card>
          <CardHeader title={`Archived concepts (${archivedShown.length})`} />
          <ul className="divide-y divide-border">
            {archivedShown.map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-6 py-2.5">
                <span className="flex w-5 shrink-0 justify-center text-muted-foreground">
                  <ConceptIcon value={c.icon || DEFAULT_CONCEPT_ICON} size={16} />
                </span>
                <button
                  type="button"
                  onClick={() => navigate(`/settings/concepts/${c.id}`)}
                  className="truncate text-left text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  {c.name}
                </button>
                <span className="flex-1 text-xs text-muted-foreground">
                  {c.recordCount
                    ? `${c.recordCount} item${c.recordCount === 1 ? "" : "s"}`
                    : "empty"}
                </span>
                {admin && (
                  <>
                    <IconButton
                      aria-label={`Restore ${c.name}`}
                      disabled={restoreConcept.isPending}
                      onClick={() => restoreConcept.mutate(c.id)}
                    >
                      <ArchiveRestore size={15} />
                    </IconButton>
                    <IconButton
                      variant="danger"
                      aria-label={`Delete ${c.name}`}
                      onClick={() => setDialog({ kind: "deleteConcept", conceptId: c.id })}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {creatingConcept && (
        <Modal title="New concept" onClose={() => setCreatingConcept(false)}>
          <div className="space-y-3">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewConcept()
              }}
              placeholder="Concept name…"
            />
            {scopedRoles.length > 0 ? (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Who can see it
                </p>
                {scopedRoles.map((r) => (
                  <div key={r.id} className="flex items-center gap-3 text-sm text-foreground">
                    <Checkbox
                      id={`can-see-${r.id}`}
                      checked={mayView(r.id)}
                      onCheckedChange={(v: boolean | "indeterminate") =>
                        setAccess((cur) => ({ ...cur, [r.id]: v === true }))
                      }
                    />
                    <label htmlFor={`can-see-${r.id}`} className="cursor-pointer">
                      {r.name}
                    </label>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Owners and admins always can. Change any of this later in Roles.
                </p>
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                onClick={submitNewConcept}
                disabled={createConcept.isPending || !newName.trim()}
              >
                <Plus size={15} />
                {createConcept.isPending ? "Creating…" : "Create"}
              </Button>
              <Button variant="outline" onClick={() => setCreatingConcept(false)}>
                <X size={15} />
                Cancel
              </Button>
            </div>
            {createConcept.error && (
              <p className="text-xs text-destructive">{msgOf(createConcept.error)}</p>
            )}
          </div>
        </Modal>
      )}

      {conceptDialogs}
    </div>
  )
}
