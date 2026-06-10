import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Archive, ArchiveRestore, Check, GitBranch, Plus, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LABELS_KEY } from "../../rpc/contract"
import { LabelMultiSelect } from "../components/LabelMultiSelect"
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  IconButton,
  Input,
  LabelChip,
  Modal,
  Spinner,
} from "../components/ui"
import { api, type Concept, type Field, type Label, type RelatedInstance } from "../lib/api"
import { useSession } from "../lib/auth-client"
import { instanceDetail, KEY, useRegisterCollection } from "../lib/collections"
import { FieldValueCell } from "../lib/fieldDisplay"
import { showValue } from "../lib/utils"
import { isAdminRole, useFullOrg } from "./settings/SettingsLayout"

/** A human label for an instance — its first non-empty text field, else untitled.
 *  State is keyed by field id, so the concept's field defs are required. */
const labelOf = (state: Record<string, unknown>, fields: ReadonlyArray<Field>): string => {
  const textField = fields.find((f) => f.kind === "text" && state[f.id])
  const v = textField ? state[textField.id] : undefined
  return v ? String(v) : "(untitled)"
}

/** Connected instances grouped by direction + relation type, each click-through.
 *  Outbound edges get a remove (×) when this instance is editable — a draft on a
 *  versioned concept, or any non-versioned instance (published versions freeze
 *  their relations along with their fields). */
function Connections({
  related,
  editable,
  onRemove,
}: {
  related: ReadonlyArray<RelatedInstance>
  editable: boolean
  onRemove: (relationId: string) => void
}) {
  const groups = new Map<string, RelatedInstance[]>()
  for (const r of related) {
    // Group by direction + relation field id (stable); label from relationName.
    const key = `${r.direction}:${r.fieldId}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }

  if (related.length === 0)
    return <div className="p-6 text-sm text-muted-foreground">Nothing connected yet.</div>

  return (
    <div className="divide-y divide-border">
      {[...groups.entries()].map(([key, items]) => {
        const first = items[0]!
        const arrow = first.direction === "out" ? "→" : "←"
        return (
          <div key={key} className="px-6 py-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {arrow} {first.relationName}
            </div>
            <div className="space-y-1">
              {items.map((r) => {
                const meta = (
                  <span className="flex items-center gap-1.5">
                    {r.pinned ? (
                      <span title="Pinned to a specific version">
                        <Badge tone="amber">Pinned v{r.instance?.versionSeq ?? "?"}</Badge>
                      </span>
                    ) : (
                      r.instance && <Badge tone="gray">Latest v{r.instance.versionSeq}</Badge>
                    )}
                    <Badge tone="blue">{r.conceptName}</Badge>
                  </span>
                )
                const removeBtn = editable && r.direction === "out" && (
                  <IconButton aria-label="Remove connection" onClick={() => onRemove(r.relationId)}>
                    <X size={14} />
                  </IconButton>
                )
                // Dangling (general ref with no published version / archived target).
                if (!r.instance)
                  return (
                    <div
                      key={r.relationId}
                      className="flex items-center justify-between rounded px-2 py-1 opacity-60"
                    >
                      <span className="text-sm italic text-muted-foreground">{r.label}</span>
                      <span className="flex items-center gap-1">
                        {meta}
                        {removeBtn}
                      </span>
                    </div>
                  )
                return (
                  <div
                    key={r.relationId}
                    className="flex items-center justify-between gap-1 rounded px-2 py-1 hover:bg-accent"
                  >
                    <Link
                      to={`/instances/${r.instance.id}`}
                      className="flex min-w-0 flex-1 items-center justify-between"
                    >
                      <span className="truncate text-sm text-foreground">{r.label}</span>
                      {meta}
                    </Link>
                    {removeBtn}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Per-item label editor. Inherited (static) labels render as locked chips; the
 * item's own labels are a draft multi-select saved via `updateInstance` (the
 * first caller of that endpoint). The draft reseeds whenever the server's label
 * set changes (after our save, or an external edit) — keyed by the id set.
 */
function LabelsCard({
  instance,
  staticLabels,
  ownLabels,
  onSaved,
}: {
  instance: { id: string; version: number }
  staticLabels: ReadonlyArray<Label>
  ownLabels: ReadonlyArray<Label>
  onSaved: () => void
}) {
  const vocab = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
  const serverKey = ownLabels.map((l) => l.id).join(",")
  const serverIds = serverKey ? serverKey.split(",") : []
  const [draft, setDraft] = useState<string[]>(serverIds)
  // Reseed to the server truth whenever it changes (not while editing a draft).
  useEffect(() => {
    setDraft(serverKey ? serverKey.split(",") : [])
  }, [serverKey])

  const save = useMutation({
    mutationFn: () => api.updateInstance(instance.id, instance.version, { [LABELS_KEY]: draft }),
    onSuccess: onSaved,
  })

  const hasVocab = (vocab.data?.length ?? 0) > 0
  if (!hasVocab && staticLabels.length === 0 && ownLabels.length === 0) return null

  const dirty = draft.length !== serverIds.length || draft.some((id) => !serverIds.includes(id))
  const staticIds = staticLabels.map((l) => l.id)

  return (
    <Card>
      <CardHeader
        title="Labels"
        action={
          dirty && (
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              <Check size={15} />
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          )
        }
      />
      <div className="space-y-3 p-6">
        {staticLabels.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Inherited</span>
            <div className="flex flex-wrap gap-1.5">
              {staticLabels.map((l) => (
                <LabelChip
                  key={l.id}
                  color={l.color}
                  primary={l.primary}
                  title="Inherited from the concept"
                >
                  {l.name}
                </LabelChip>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">This item</span>
          {hasVocab ? (
            <LabelMultiSelect
              all={vocab.data ?? []}
              selectedIds={draft}
              onChange={setDraft}
              excludeIds={staticIds}
              emptyHint="No labels available."
            />
          ) : ownLabels.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {ownLabels.map((l) => (
                <LabelChip key={l.id} color={l.color} primary={l.primary}>
                  {l.name}
                </LabelChip>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">None.</p>
          )}
        </div>
        {save.error && <p className="text-sm text-destructive">{(save.error as Error).message}</p>}
      </div>
    </Card>
  )
}

/**
 * Add a connection: pick a relation field, search the target concept's items
 * (head/latest per item), and — when the target concept is versioned — choose
 * between referencing "Latest" (follows republishes) or pinning a specific
 * published version.
 */
function AddConnectionModal({
  fromId,
  relationFields,
  concepts,
  onDone,
  onClose,
}: {
  fromId: string
  relationFields: ReadonlyArray<Field>
  concepts: ReadonlyArray<Concept>
  onDone: () => void
  onClose: () => void
}) {
  const [fieldId, setFieldId] = useState(relationFields[0]?.id ?? "")
  const [query, setQuery] = useState("")
  const [pick, setPick] = useState<{ itemId: string; label: string } | null>(null)
  // "latest" = general ref (toItemId); otherwise a published version's instance id.
  const [versionChoice, setVersionChoice] = useState<string>("latest")

  const field = relationFields.find((f) => f.id === fieldId)
  const targetConcept = concepts.find((c) => c.id === field?.config.target)
  const targetVersioned = targetConcept?.versioningEnabled ?? false

  const results = useQuery({
    queryKey: ["search", field?.config.target, query],
    queryFn: () => api.searchInstances(field!.config.target!, query),
    enabled: !!field?.config.target && !pick,
  })
  const versionsQ = useQuery({
    queryKey: ["versions", pick?.itemId],
    queryFn: () => api.listVersions(pick!.itemId),
    enabled: !!pick && targetVersioned,
  })
  const pinnable =
    versionsQ.data?.filter((v) => v.versionStatus === "published" && !v.archivedAt) ?? []

  const create = useMutation({
    mutationFn: () =>
      api.createRelation(
        versionChoice === "latest"
          ? { fieldId, fromId, toItemId: pick!.itemId }
          : { fieldId, fromId, toVersionId: versionChoice },
      ),
    onSuccess: () => {
      onDone()
      onClose()
    },
  })

  return (
    <Modal title="Add connection" onClose={onClose}>
      <div className="space-y-4">
        {relationFields.length > 1 && (
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Relation</span>
            <Select
              value={fieldId}
              onValueChange={(v) => {
                setFieldId(v)
                setPick(null)
                setVersionChoice("latest")
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {relationFields.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1.5">
          <span className="text-sm font-medium text-foreground">
            {targetConcept ? targetConcept.name : "Target"}
          </span>
          {pick ? (
            <div className="flex items-center justify-between rounded border border-border px-3 py-2">
              <span className="text-sm text-foreground">{pick.label}</span>
              <IconButton
                aria-label="Clear selection"
                onClick={() => {
                  setPick(null)
                  setVersionChoice("latest")
                }}
              >
                <X size={14} />
              </IconButton>
            </div>
          ) : (
            <>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                autoFocus
              />
              <div className="max-h-48 space-y-0.5 overflow-y-auto">
                {(results.data ?? []).map((r) => (
                  <button
                    key={r.itemId}
                    type="button"
                    onClick={() => setPick({ itemId: r.itemId, label: r.label })}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span className="text-foreground">{r.label}</span>
                    {targetVersioned && <Badge tone="gray">v{r.versionSeq}</Badge>}
                  </button>
                ))}
                {results.data?.length === 0 && (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    No published items match.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {pick && targetVersioned && (
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Reference</span>
            <Select value={versionChoice} onValueChange={setVersionChoice}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">Latest — follows new published versions</SelectItem>
                {pinnable.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    Pin v{v.versionSeq}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {create.error && (
          <p className="text-sm text-destructive">{(create.error as Error).message}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!pick || create.isPending}>
            <Plus size={15} />
            {create.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Version history + lifecycle for a versioned item. Lists every version (draft +
 * published), lets you switch between them, open a new draft, and publish/discard
 * the open draft. Per-version archive lives here; whole-item archive is on the
 * page header.
 */
function VersionsCard({
  itemId,
  current,
  conceptId,
  onChanged,
}: {
  itemId: string
  current: { id: string; version: number; versionStatus: "draft" | "published"; versionSeq: number }
  conceptId: string
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const versionsQ = useQuery({
    queryKey: ["versions", itemId],
    queryFn: () => api.listVersions(itemId),
  })
  const versions = versionsQ.data ?? []
  const published = versions.filter((v) => v.versionStatus === "published" && !v.archivedAt)
  const headSeq = published.length ? Math.max(...published.map((v) => v.versionSeq)) : null
  const draft = versions.find((v) => v.versionStatus === "draft" && !v.archivedAt)

  const refetch = () => {
    versionsQ.refetch()
    onChanged()
  }
  const newVersion = useMutation({
    mutationFn: () => api.newVersion(itemId),
    onSuccess: (d) => {
      refetch()
      navigate(`/instances/${d.id}`)
    },
  })
  const publish = useMutation({
    mutationFn: () => api.publishVersion(current.id, current.version),
    onSuccess: refetch,
  })
  const discard = useMutation({
    mutationFn: () => api.discardDraft(current.id),
    onSuccess: () => {
      refetch()
      if (headSeq != null) {
        const head = published.find((v) => v.versionSeq === headSeq)
        if (head) navigate(`/instances/${head.id}`)
      }
    },
  })
  const archiveVersion = useMutation({
    mutationFn: (v: { id: string; version: number }) => api.archiveInstance(v.id, v.version),
    onSuccess: refetch,
  })
  const restoreVersion = useMutation({
    mutationFn: (v: { id: string; version: number }) => api.restoreInstance(v.id, v.version),
    onSuccess: refetch,
  })

  const onDraft = current.versionStatus === "draft"
  const err =
    newVersion.error || publish.error || discard.error || archiveVersion.error || restoreVersion.error

  return (
    <Card>
      <CardHeader
        title="Versions"
        action={
          onDraft ? (
            <div className="flex gap-2">
              <Button onClick={() => publish.mutate()} disabled={publish.isPending}>
                <Check size={15} />
                {publish.isPending ? "Publishing…" : "Publish"}
              </Button>
              <Button
                variant="outline"
                onClick={() => discard.mutate()}
                disabled={discard.isPending}
              >
                Discard
              </Button>
            </div>
          ) : (
            // One draft at a time: "New version" is disabled while a draft is open.
            <Button
              onClick={() => newVersion.mutate()}
              disabled={newVersion.isPending || !!draft}
              title={draft ? "Publish or discard the open draft first" : undefined}
            >
              <GitBranch size={15} />
              New version
            </Button>
          )
        }
      />
      <div className="divide-y divide-border">
        {versions.length === 0 && (
          <div className="p-6 text-sm text-muted-foreground">No versions yet.</div>
        )}
        {[...versions].reverse().map((v) => {
          const isHead = v.versionStatus === "published" && v.versionSeq === headSeq
          const isCurrent = v.id === current.id
          return (
            <div
              key={v.id}
              className={`flex items-center justify-between px-6 py-2 ${isCurrent ? "bg-accent/40" : ""}`}
            >
              <button
                type="button"
                onClick={() => navigate(`/instances/${v.id}`)}
                className="flex items-center gap-2 text-left text-sm hover:underline"
              >
                <span className="font-medium text-foreground">v{v.versionSeq}</span>
                {v.versionStatus === "draft" ? (
                  <Badge tone="amber">Draft</Badge>
                ) : isHead ? (
                  <Badge tone="green">Latest</Badge>
                ) : (
                  <Badge tone="gray">Published</Badge>
                )}
                {v.archivedAt && <Badge tone="gray">Archived</Badge>}
              </button>
              {v.versionStatus === "published" &&
                (v.archivedAt ? (
                  <Button
                    variant="ghost"
                    onClick={() => restoreVersion.mutate({ id: v.id, version: v.version })}
                  >
                    <ArchiveRestore size={14} />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => archiveVersion.mutate({ id: v.id, version: v.version })}
                    title="Archive this version"
                  >
                    <Archive size={14} />
                  </Button>
                ))}
            </div>
          )
        })}
      </div>
      {err && <p className="px-6 pb-4 text-sm text-destructive">{(err as Error).message}</p>}
    </Card>
  )
}

/** Single-instance detail: all of its own data plus everything connected to it. */
export function InstanceView() {
  const { id = "" } = useParams()

  const collection = instanceDetail(id)
  useRegisterCollection(KEY.detail(id), collection)
  const detailQ = useLiveQuery(
    (q) => (id ? q.from({ d: collection }) : undefined),
    [id, collection],
  )
  const detail = detailQ.data?.[0]

  // A hard delete is admin-only; archive is an ordinary item write.
  const navigate = useNavigate()
  const { data: session } = useSession()
  const org = useFullOrg()
  const myRole = org.data?.members?.find((m) => m.userId === session?.user.id)?.role
  const admin = isAdminRole(myRole)
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null)
  const [addingConnection, setAddingConnection] = useState(false)

  // All concepts — to resolve relation targets' versioningEnabled in the picker.
  const allConcepts = useQuery({ queryKey: ["concepts"], queryFn: () => api.listConcepts() })
  const removeRel = useMutation({
    mutationFn: (relationId: string) => api.removeRelation(relationId),
    onSuccess: () => collection.utils.refetch(),
  })

  // Both navigate back to the concept on success (the item leaves the live view).
  const backToConcept = () => {
    if (detail) navigate(`/concepts/${detail.concept.id}`)
  }
  const archive = useMutation({
    mutationFn: (inst: { id: string; version: number }) =>
      api.archiveInstance(inst.id, inst.version),
    onSuccess: () => {
      setDialog(null)
      backToConcept()
    },
  })
  // For a versioned concept the header "Archive" hides the whole item (lineage);
  // per-version archive lives in the Versions panel.
  const archiveItem = useMutation({
    mutationFn: (itemId: string) => api.archiveItem(itemId),
    onSuccess: () => {
      setDialog(null)
      backToConcept()
    },
  })
  const del = useMutation({
    mutationFn: (instId: string) => api.deleteInstance(instId),
    onSuccess: () => {
      setDialog(null)
      backToConcept()
    },
  })

  if (detailQ.isLoading || !detail) return <Spinner />

  const { instance, concept, fields, related, staticLabels, labels } = detail
  // Show declared fields in their defined order, plus any orphaned state keys —
  // field ids whose def was deleted (skip engine-internal markers like `__bands`).
  const declared = new Set(fields.map((f) => f.id))
  const extras = Object.keys(instance.state).filter((k) => !declared.has(k) && !k.startsWith("__"))
  // Relations are editable on a draft (versioned) or any non-versioned instance —
  // a published version is frozen, connections included.
  const relationFields = fields.filter((f) => f.kind === "relation")
  const relationsEditable = concept.versioningEnabled
    ? instance.versionStatus === "draft"
    : true

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link
            to={`/concepts/${concept.id}`}
            className="text-xs text-muted-foreground hover:text-muted-foreground"
          >
            ← {concept.name}
          </Link>
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
            {labelOf(instance.state, fields)}
            {concept.versioningEnabled &&
              (instance.versionStatus === "draft" ? (
                <Badge tone="amber">Draft v{instance.versionSeq}</Badge>
              ) : (
                <Badge tone="gray">v{instance.versionSeq}</Badge>
              ))}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => setDialog("archive")}>
            <Archive size={15} />
            {concept.versioningEnabled ? "Archive item" : "Archive"}
          </Button>
          {admin && (
            <Button variant="destructive" onClick={() => setDialog("delete")}>
              <Trash2 size={15} />
              Delete
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <dl className="divide-y divide-border text-sm">
            {fields.map((f) => (
              <div key={f.id} className="flex items-center justify-between px-6 py-2">
                <dt className="text-muted-foreground">{f.name}</dt>
                <dd className="text-right">
                  <FieldValueCell field={f} value={instance.state[f.id]} />
                </dd>
              </div>
            ))}
            {extras.map((k) => (
              <div key={k} className="flex items-center justify-between px-6 py-2">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="text-right text-foreground">{showValue(instance.state[k])}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <CardHeader
            title="Connected"
            action={
              relationsEditable &&
              relationFields.length > 0 && (
                <Button variant="outline" onClick={() => setAddingConnection(true)}>
                  <Plus size={15} />
                  Add
                </Button>
              )
            }
          />
          <Connections
            related={related}
            editable={relationsEditable}
            onRemove={(relationId) => removeRel.mutate(relationId)}
          />
          {removeRel.error && (
            <p className="px-6 pb-4 text-sm text-destructive">
              {(removeRel.error as Error).message}
            </p>
          )}
        </Card>

        <LabelsCard
          instance={instance}
          staticLabels={staticLabels}
          ownLabels={labels}
          onSaved={() => collection.utils.refetch()}
        />

        {concept.versioningEnabled && (
          <VersionsCard
            itemId={instance.itemId}
            current={instance}
            conceptId={concept.id}
            onChanged={() => collection.utils.refetch()}
          />
        )}
      </div>

      {addingConnection && (
        <AddConnectionModal
          fromId={instance.id}
          relationFields={relationFields}
          concepts={allConcepts.data ?? []}
          onDone={() => collection.utils.refetch()}
          onClose={() => setAddingConnection(false)}
        />
      )}

      {dialog === "archive" && (
        <ConfirmDialog
          title="Archive item"
          message={
            concept.versioningEnabled ? (
              <>
                Archive <strong>{labelOf(instance.state, fields)}</strong> and all its versions?
                It's hidden from lists but kept — restore it from "Show archived".
              </>
            ) : (
              <>
                Archive <strong>{labelOf(instance.state, fields)}</strong>? It's hidden from lists but
                kept — you can restore it from the {concept.name} view's "Show archived".
              </>
            )
          }
          confirmLabel="Archive"
          pending={archive.isPending || archiveItem.isPending}
          error={
            (archive.error || archiveItem.error
              ? ((archive.error || archiveItem.error) as { message?: string }).message
              : undefined) ?? undefined
          }
          onConfirm={() =>
            concept.versioningEnabled
              ? archiveItem.mutate(instance.itemId)
              : archive.mutate(instance)
          }
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title="Delete item"
          message={
            <>
              Permanently delete <strong>{labelOf(instance.state, fields)}</strong>? This can't be
              undone, and is refused while other items still link to it.
            </>
          }
          confirmLabel="Delete"
          confirmVariant="danger"
          secondaryLabel="Archive instead"
          onSecondary={() => archive.mutate(instance)}
          pending={del.isPending || archive.isPending}
          error={
            del.error
              ? ((del.error as { message?: string }).message ?? "Could not delete.")
              : undefined
          }
          onConfirm={() => del.mutate(instance.id)}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  )
}
