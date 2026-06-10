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
import { api, type Concept, type Field, type RelatedInstance } from "../../lib/api"
import { Badge, Button, IconButton, Input, Modal } from "../ui"
import type { InstanceCtx } from "./types"

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

export function ConnectedBody({ ctx }: { ctx: InstanceCtx }) {
  const removeRel = useMutation({
    mutationFn: (relationId: string) => api.removeRelation(relationId),
    onSuccess: () => ctx.refetch(),
  })
  return (
    <>
      <Connections
        related={ctx.related}
        editable={ctx.editable}
        onRemove={(relationId) => removeRel.mutate(relationId)}
      />
      {removeRel.error && (
        <p className="px-6 pb-4 text-sm text-destructive">{(removeRel.error as Error).message}</p>
      )}
    </>
  )
}

export function ConnectedActions({ ctx }: { ctx: InstanceCtx }) {
  const [adding, setAdding] = useState(false)
  if (!ctx.editable || ctx.relationFields.length === 0) return null
  return (
    <>
      <Button variant="outline" onClick={() => setAdding(true)}>
        <Plus size={15} />
        Add
      </Button>
      {adding && (
        <AddConnectionModal
          fromId={ctx.instance.id}
          relationFields={ctx.relationFields}
          concepts={ctx.concepts}
          onDone={() => ctx.refetch()}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  )
}
