import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Archive, Check, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { LABELS_KEY } from "../../rpc/contract"
import { LabelMultiSelect } from "../components/LabelMultiSelect"
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  decayTone,
  LabelChip,
  momentumTone,
  Spinner,
} from "../components/ui"
import {
  api,
  type DecayValue,
  type Field,
  type Label,
  type MomentumValue,
  type RelatedInstance,
} from "../lib/api"
import { useSession } from "../lib/auth-client"
import { instanceDetail, KEY, useRegisterCollection } from "../lib/collections"
import { showValue } from "../lib/utils"
import { isAdminRole, useFullOrg } from "./settings/SettingsLayout"

/** A human label for an instance — its first non-empty text field, else untitled.
 *  State is keyed by field id, so the concept's field defs are required. */
const labelOf = (state: Record<string, unknown>, fields: ReadonlyArray<Field>): string => {
  const textField = fields.find((f) => f.kind === "text" && state[f.id])
  const v = textField ? state[textField.id] : undefined
  return v ? String(v) : "(untitled)"
}

/** Render one field value, with badges for the computed decay/momentum shapes. */
function FieldValue({ field, value }: { field: Field; value: unknown }) {
  if (field.kind === "computed" && field.config.computedKind === "decay") {
    const d = value as DecayValue | undefined
    if (!d) return <span className="text-gray-400">—</span>
    return (
      <Badge tone={decayTone(d.band)}>
        {d.band} · {d.days ?? "—"}d
      </Badge>
    )
  }
  if (field.kind === "computed" && field.config.computedKind === "momentum") {
    const m = value as MomentumValue | undefined
    if (!m) return <span className="text-gray-400">—</span>
    return <Badge tone={momentumTone(m.label)}>{m.label}</Badge>
  }
  return <span className="text-gray-700">{showValue(value)}</span>
}

/** Connected instances grouped by direction + relation type, each click-through. */
function Connections({ related }: { related: ReadonlyArray<RelatedInstance> }) {
  const groups = new Map<string, RelatedInstance[]>()
  for (const r of related) {
    // Group by direction + relation field id (stable); label from relationName.
    const key = `${r.direction}:${r.fieldId}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }

  if (related.length === 0)
    return <div className="p-4 text-sm text-gray-400">Nothing connected yet.</div>

  return (
    <div className="divide-y divide-gray-100">
      {[...groups.entries()].map(([key, items]) => {
        const first = items[0]!
        const arrow = first.direction === "out" ? "→" : "←"
        return (
          <div key={key} className="px-4 py-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
              {arrow} {first.relationName}
            </div>
            <div className="space-y-1">
              {items.map((r) => (
                <Link
                  key={r.relationId}
                  to={`/instances/${r.instance.id}`}
                  className="flex items-center justify-between rounded px-2 py-1 hover:bg-gray-50"
                >
                  <span className="text-sm text-gray-700">{r.label}</span>
                  <Badge tone="blue">{r.conceptName}</Badge>
                </Link>
              ))}
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
      <div className="space-y-3 p-4">
        {staticLabels.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-gray-500">Inherited</span>
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
          <span className="text-xs font-medium text-gray-500">This item</span>
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
            <p className="text-xs text-gray-400">None.</p>
          )}
        </div>
        {save.error && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
      </div>
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

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link
            to={`/concepts/${concept.id}`}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            ← {concept.name}
          </Link>
          <h2 className="text-lg font-semibold text-gray-800">{labelOf(instance.state, fields)}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => setDialog("archive")}>
            <Archive size={15} />
            Archive
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
          <dl className="divide-y divide-gray-100 text-sm">
            {fields.map((f) => (
              <div key={f.id} className="flex items-center justify-between px-4 py-2">
                <dt className="text-gray-400">{f.name}</dt>
                <dd className="text-right">
                  <FieldValue field={f} value={instance.state[f.id]} />
                </dd>
              </div>
            ))}
            {extras.map((k) => (
              <div key={k} className="flex items-center justify-between px-4 py-2">
                <dt className="text-gray-400">{k}</dt>
                <dd className="text-right text-gray-700">{showValue(instance.state[k])}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <CardHeader title="Connected" />
          <Connections related={related} />
        </Card>

        <LabelsCard
          instance={instance}
          staticLabels={staticLabels}
          ownLabels={labels}
          onSaved={() => collection.utils.refetch()}
        />
      </div>

      {dialog === "archive" && (
        <ConfirmDialog
          title="Archive item"
          message={
            <>
              Archive <strong>{labelOf(instance.state, fields)}</strong>? It's hidden from lists but
              kept — you can restore it from the {concept.name} view's "Show archived".
            </>
          }
          confirmLabel="Archive"
          pending={archive.isPending}
          error={
            archive.error
              ? ((archive.error as { message?: string }).message ?? "Could not archive.")
              : undefined
          }
          onConfirm={() => archive.mutate(instance)}
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
