import { api } from "../../lib/api"
import type { SaveCell } from "../InlineCellEditor"
import { Card } from "../ui"
import { DetailFieldEditor } from "./DetailFieldEditor"
import type { InstanceCtx } from "./types"

/**
 * The EDITABLE half of a connector-managed concept's detail view: the user-added
 * fields (`managedBy` null), which members own and may edit even though the
 * record itself is synced + read-only. Reuses the same inline editor +
 * `updateInstance` autosave as the regular Details tile, so a save here is an
 * `InstanceUpdated` event in the Activity feed. The synced fields are rendered
 * read-only elsewhere ({@link ManagedRecordView} / the kind-specific body).
 *
 * Renders nothing when the concept has no user fields — so a freshly-synced
 * concept shows only the read-only body until someone adds their own field in
 * concept settings.
 */
export function ManagedUserFields({ ctx }: { ctx: InstanceCtx }) {
  const { instance, editable, refetch } = ctx
  const fields = ctx.fields
    .filter((f) => !f.archivedAt && !f.managedBy)
    .slice()
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
  if (fields.length === 0) return null

  // One field per save; refetch (success or fail) reconciles value + version —
  // mirrors DetailsContent's saveCell.
  const saveCell: SaveCell = async (inst, fieldId, value) => {
    try {
      await api.updateInstance(inst.id, inst.version, { [fieldId]: value })
    } finally {
      refetch()
    }
  }

  return (
    <Card className="max-w-2xl shrink-0">
      <p className="px-4 pt-3 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Your fields
      </p>
      <dl className="divide-y text-sm">
        {fields.map((f) => (
          <div key={f.id} className="flex items-center justify-between gap-4 px-4 py-2">
            <dt className="shrink-0 truncate text-muted-foreground" title={f.name}>
              {f.name}
            </dt>
            <dd className="min-w-0 flex-1 text-right">
              {editable ? (
                <DetailFieldEditor field={f} instance={instance} onSave={saveCell} />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
