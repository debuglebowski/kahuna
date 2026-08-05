import { useMutation, useQuery } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router-dom"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, type Concept, type Field, type RelatedRecord } from "../../lib/api"
import { canEditPublished } from "../../lib/editability"
import { recordHref } from "../../lib/recordHref"
import { Badge, Button, IconButton, Input, Modal } from "../ui"
import type { RecordVersionCtx } from "./types"

/** A group's heading: outbound shows the field name; inbound prefers the
 *  field's inverse-side labels (singular/plural by count), defaulting to the
 *  SOURCE concept's name/pluralName — the field name describes the other end
 *  of the edge, so it reads wrong from this side. */
function groupHeading(
  items: ReadonlyArray<RelatedRecord>,
  conceptById: ReadonlyMap<string, Concept>,
): string {
  const first = items[0]!
  if (first.direction === "out") return first.relationName
  const concept = conceptById.get(first.conceptId)
  const singular = first.relationInverseName ?? concept?.name ?? first.conceptName
  if (items.length === 1) return singular
  // A custom singular without a plural beats jumping back to the concept name.
  return (
    first.relationInversePluralName ?? first.relationInverseName ?? concept?.pluralName ?? singular
  )
}

/** Connected record versions grouped by direction + relation type, each click-through.
 *  An edge gets a remove (×) when the record version that OWNS it (the relation's
 *  `from`) is editable — outbound: this record version is a draft on a versioned
 *  concept or any non-versioned record version; inbound: the source is non-versioned
 *  (published versions freeze their relations along with their fields). */
function Connections({
  related,
  conceptById,
  canRemove,
  onRemove,
  viewByField,
}: {
  related: ReadonlyArray<RelatedRecord>
  conceptById: ReadonlyMap<string, Concept>
  canRemove: (r: RelatedRecord) => boolean
  onRemove: (relationId: string) => void
  /** Outbound relation field id → record-dashboard id to open its targets with
   *  (the field's `config.recordDashboardId`). Inbound edges aren't in the map. */
  viewByField: ReadonlyMap<string, string | null>
}) {
  const groups = new Map<string, RelatedRecord[]>()
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
        return (
          <div key={key} className="px-6 py-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {groupHeading(items, conceptById)}
            </div>
            <div className="space-y-1">
              {items.map((r) => {
                const meta = (
                  <span className="flex items-center gap-1.5">
                    {r.pinned ? (
                      <span title="Pinned to a specific version">
                        <Badge tone="amber">Pinned v{r.recordVersion?.versionSeq ?? "?"}</Badge>
                      </span>
                    ) : (
                      r.recordVersion && (
                        <Badge tone="gray">Latest v{r.recordVersion.versionSeq}</Badge>
                      )
                    )}
                    <Badge tone="blue">{r.conceptName}</Badge>
                  </span>
                )
                const removeBtn = canRemove(r) && (
                  <IconButton aria-label="Remove connection" onClick={() => onRemove(r.relationId)}>
                    <X size={14} />
                  </IconButton>
                )
                // Dangling (general ref with no published version / archived target).
                if (!r.recordVersion)
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
                      to={recordHref(r.recordVersion.id, { dashboard: viewByField.get(r.fieldId) })}
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

/** One pickable connection kind in the Add modal — a relation field plus the
 *  side of it this record version sits on. `out`: this record version owns the edge and the
 *  picker searches the field's target. `in`: the picked record version owns the edge
 *  (so it must be editable — non-versioned source concepts only) and the picker
 *  searches the field's OWNING concept. */
export interface RelationOption {
  readonly key: string
  readonly field: Field
  readonly dir: "out" | "in"
  readonly label: string
  /** Concept whose record versions the picker searches (target for out, source for in). */
  readonly searchConceptId: string
}

/**
 * Add a connection: pick a relation (either direction), search the other side's
 * items (head/latest per item), and — when the referenced side is versioned —
 * choose between referencing "Latest" (follows republishes) or pinning a
 * specific published version. Inbound: the reference always points at THIS
 * item, so the pin choice is this very version (when published).
 */
function AddConnectionModal({
  ctx,
  options,
  onDone,
  onClose,
}: {
  ctx: RecordVersionCtx
  options: ReadonlyArray<RelationOption>
  onDone: () => void
  onClose: () => void
}) {
  const [optionKey, setOptionKey] = useState(options[0]?.key ?? "")
  const [query, setQuery] = useState("")
  const [pick, setPick] = useState<{
    recordId: string
    recordVersionId: string
    label: string
  } | null>(null)
  // "latest" = general ref (toItemId); otherwise a published version's record version id.
  const [versionChoice, setVersionChoice] = useState<string>("latest")

  const option = options.find((o) => o.key === optionKey)
  const searchConcept = ctx.concepts.find((c) => c.id === option?.searchConceptId)
  // A single-record concept has exactly one pickable record, so the search box is
  // noise — the one row is the whole list. The pick stays explicit rather than
  // auto-selecting: which end owns the edge and whether it pins a version are still
  // real choices, and a silent selection would hide them.
  const soleTarget = searchConcept?.singleRecord ?? false
  // Whether the REFERENCED side is versioned (out: the picked target; in: this record).
  const referencedVersioned =
    option?.dir === "out"
      ? (searchConcept?.versioningEnabled ?? false)
      : ctx.concept.versioningEnabled

  const results = useQuery({
    queryKey: ["search", option?.searchConceptId, query],
    queryFn: () => api.searchRecords(option!.searchConceptId, query),
    enabled: !!option && !pick,
  })
  const versionsQ = useQuery({
    queryKey: ["versions", pick?.recordId],
    queryFn: () => api.listVersions(pick!.recordId),
    enabled: !!pick && option?.dir === "out" && referencedVersioned,
  })
  const pinnable =
    versionsQ.data?.filter((v) => v.versionStatus === "published" && !v.archivedAt) ?? []

  const create = useMutation({
    mutationFn: () => {
      const fieldId = option!.field.id
      if (option!.dir === "out") {
        return api.createRelation(
          versionChoice === "latest"
            ? { fieldId, fromId: ctx.recordVersion.id, toRecordId: pick!.recordId }
            : { fieldId, fromId: ctx.recordVersion.id, toVersionId: versionChoice },
        )
      }
      // Inbound: the picked record version owns the edge; the reference is this record.
      return api.createRelation(
        versionChoice === "latest"
          ? { fieldId, fromId: pick!.recordVersionId, toRecordId: ctx.recordVersion.recordId }
          : { fieldId, fromId: pick!.recordVersionId, toVersionId: versionChoice },
      )
    },
    onSuccess: () => {
      onDone()
      onClose()
    },
  })

  return (
    <Modal title="Add connection" onClose={onClose}>
      <div className="space-y-4">
        {options.length > 1 && (
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Relation</span>
            <Select
              value={optionKey}
              onValueChange={(v) => {
                setOptionKey(v)
                setPick(null)
                setVersionChoice("latest")
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.key} value={o.key}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1.5">
          <span className="text-sm font-medium text-foreground">
            {searchConcept ? searchConcept.name : "Target"}
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
              {!soleTarget && (
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  autoFocus
                />
              )}
              <div className="max-h-48 space-y-0.5 overflow-y-auto">
                {(results.data ?? []).map((r) => (
                  <button
                    key={r.recordId}
                    type="button"
                    onClick={() =>
                      setPick({
                        recordId: r.recordId,
                        recordVersionId: r.recordVersionId,
                        label: r.label,
                      })
                    }
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span className="text-foreground">{r.label}</span>
                    {(searchConcept?.versioningEnabled ?? false) && (
                      <Badge tone="gray">v{r.versionSeq}</Badge>
                    )}
                  </button>
                ))}
                {results.data?.length === 0 && (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    {soleTarget
                      ? // The search is head-only, so a versioned single-record
                        // concept whose record is still an unpublished draft has
                        // nothing referenceable yet — say which, not "no match".
                        `${searchConcept?.name ?? "It"} has no published record to link to yet.`
                      : "No published items match."}
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {pick && referencedVersioned && (
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">Reference</span>
            <Select value={versionChoice} onValueChange={setVersionChoice}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">Latest — follows new published versions</SelectItem>
                {option?.dir === "out"
                  ? pinnable.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        Pin v{v.versionSeq}
                      </SelectItem>
                    ))
                  : // Inbound references point at THIS item — the only offerable
                    // pin is the version being viewed (drafts aren't referenceable).
                    ctx.recordVersion.versionStatus === "published" && (
                      <SelectItem value={ctx.recordVersion.id}>
                        Pin v{ctx.recordVersion.versionSeq} (this version)
                      </SelectItem>
                    )}
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

export function ConnectedBody({ ctx }: { ctx: RecordVersionCtx }) {
  const removeRel = useMutation({
    mutationFn: (relationId: string) => api.removeRelation(relationId),
    onSuccess: () => ctx.refetch(),
  })
  // An edge is removable when its OWNING record version (the relation's `from`) is
  // editable. Outbound: this record version (ctx.editable). Inbound: the source — always
  // a published version (drafts never surface as inbound), so it's editable when
  // its concept is non-versioned OR allows amending published versions.
  const conceptById = new Map(ctx.concepts.map((c) => [c.id, c]))
  const canRemove = (r: RelatedRecord) =>
    r.direction === "out"
      ? ctx.editable
      : !!r.recordVersion && canEditPublished(conceptById.get(r.conceptId))
  // Outbound relation fields can pin which record dashboard their targets open
  // with (config.recordDashboardId names a dashboard of the field's target concept).
  const viewByField = new Map<string, string | null>(
    ctx.relationFields.map((f) => [f.id, f.config.recordDashboardId ?? null]),
  )
  return (
    <>
      <Connections
        related={ctx.related}
        conceptById={conceptById}
        canRemove={canRemove}
        onRemove={(relationId) => removeRel.mutate(relationId)}
        viewByField={viewByField}
      />
      {removeRel.error && (
        <p className="px-6 pb-4 text-sm text-destructive">{(removeRel.error as Error).message}</p>
      )}
    </>
  )
}

/** Both sides' addable connection kinds. Outbound needs this record version editable;
 *  inbound needs an editable SOURCE. The picker only surfaces published heads, so
 *  the source concept must be non-versioned or allow amending published versions. */
function relationOptions(ctx: RecordVersionCtx): RelationOption[] {
  const conceptById = new Map(ctx.concepts.map((c) => [c.id, c]))
  const out: RelationOption[] = ctx.editable
    ? ctx.relationFields
        .filter((f) => !!f.config.target)
        .map((f) => ({
          key: `out:${f.id}`,
          field: f,
          dir: "out",
          label: f.name,
          searchConceptId: f.config.target!,
        }))
    : []
  const inbound: RelationOption[] = ctx.inboundRelationFields
    .filter((f) => canEditPublished(conceptById.get(f.conceptId)))
    .map((f) => ({
      key: `in:${f.id}`,
      field: f,
      dir: "in",
      // Default to the source concept (what gets picked); the field name alone
      // would describe THIS side. Keep it parenthesised to disambiguate two
      // unnamed inbound relations from the same concept.
      label:
        f.config.inverseName ?? `${conceptById.get(f.conceptId)?.name ?? f.conceptId} (${f.name})`,
      searchConceptId: f.conceptId,
    }))
  return [...out, ...inbound]
}

export function ConnectedActions({ ctx }: { ctx: RecordVersionCtx }) {
  const [adding, setAdding] = useState(false)
  const options = relationOptions(ctx)
  if (options.length === 0) return null
  return (
    <>
      <Button variant="outline" onClick={() => setAdding(true)}>
        <Plus size={15} />
        Add
      </Button>
      {adding && (
        <AddConnectionModal
          ctx={ctx}
          options={options}
          onDone={() => ctx.refetch()}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  )
}
