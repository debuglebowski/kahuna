import { FieldValueCell } from "../../lib/fieldDisplay"
import { Card } from "../ui"
import type { RecordVersionCtx } from "./types"

/**
 * Opinionated, READ-ONLY detail view for the SYNCED fields of a connector-managed
 * concept (Linear ticket, Calendar event, …) — the data the integration owns
 * (`managedBy` set). Renders them as a fixed definition list via the shared
 * {@link FieldValueCell} — no inline editing, no customizable layout (that's the
 * "opinionated" part). User-added fields are editable separately
 * ({@link ManagedUserFields}). Field-kind aware, keyed off field defs — never names.
 */
export function ManagedRecordView({ ctx }: { ctx: RecordVersionCtx }) {
  const fields = ctx.fields
    .filter((f) => !f.archivedAt && !!f.managedBy)
    .slice()
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Card className="max-w-2xl">
        <dl className="divide-y">
          {fields.map((f) => (
            <div key={f.id} className="grid grid-cols-3 items-baseline gap-3 px-4 py-2.5 text-sm">
              <dt className="truncate text-muted-foreground" title={f.name}>
                {f.name}
              </dt>
              <dd className="col-span-2 min-w-0 text-foreground">
                <FieldValueCell field={f} value={ctx.recordVersion.state[f.id]} />
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  )
}
