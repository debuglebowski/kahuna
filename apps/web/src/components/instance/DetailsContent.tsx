import { FieldValueCell } from "../../lib/fieldDisplay"
import { showValue } from "../../lib/utils"
import type { InstanceCtx } from "./types"

/** Field values in declared order, plus any orphaned state keys — field ids
 *  whose def was deleted (engine-internal `__` markers are skipped). */
export function DetailsBody({ ctx }: { ctx: InstanceCtx }) {
  const { instance, fields } = ctx
  const declared = new Set(fields.map((f) => f.id))
  const extras = Object.keys(instance.state).filter((k) => !declared.has(k) && !k.startsWith("__"))
  return (
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
  )
}
