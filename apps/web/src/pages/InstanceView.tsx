import { useLiveQuery } from "@tanstack/react-db"
import { Link, useParams } from "react-router-dom"
import { Badge, Card, CardHeader, decayTone, momentumTone, Spinner } from "../components/ui"
import type { DecayValue, Field, MomentumValue, RelatedInstance } from "../lib/api"
import { instanceDetail, KEY, useRegisterCollection } from "../lib/collections"
import { showValue } from "../lib/utils"

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

  if (detailQ.isLoading || !detail) return <Spinner />

  const { instance, concept, fields, related } = detail
  // Show declared fields in their defined order, plus any orphaned state keys —
  // field ids whose def was deleted (skip engine-internal markers like `__bands`).
  const declared = new Set(fields.map((f) => f.id))
  const extras = Object.keys(instance.state).filter((k) => !declared.has(k) && !k.startsWith("__"))

  return (
    <div className="space-y-3">
      <div>
        <Link to={`/concepts/${concept.id}`} className="text-xs text-gray-400 hover:text-gray-600">
          ← {concept.name}
        </Link>
        <h2 className="text-lg font-semibold text-gray-800">{labelOf(instance.state, fields)}</h2>
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
      </div>
    </div>
  )
}
