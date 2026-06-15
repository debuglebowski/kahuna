import { Lock } from "lucide-react"
import { EmailThreadView } from "./EmailThreadView"
import { ManagedRecordView } from "./ManagedRecordView"
import { ManagedUserFields } from "./ManagedUserFields"
import type { InstanceCtx } from "./types"

/** Human label for a managed-concept kind (the `managedBy` discriminator). */
const KIND_LABEL: Record<string, string> = {
  linear: "Linear",
  "google.calendar": "Google Calendar",
  "google.gmail": "Gmail",
}

/**
 * The opinionated detail view for a connector-managed concept, dispatched by its
 * `managedBy` kind. Renders a "synced · read-only" banner (the visual mark) above
 * the user's own EDITABLE fields ({@link ManagedUserFields}, shown only when any
 * exist) and a kind-specific read-only body for the synced data: Gmail → a thread
 * reader, every other managed kind → the {@link ManagedRecordView}. Keyed by the
 * typed kind, never by concept name.
 */
export function ManagedInstanceView({ ctx }: { ctx: InstanceCtx }) {
  const kind = ctx.concept.managedBy ?? ""
  const label = KIND_LABEL[kind] ?? kind
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-1.5 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <Lock size={13} />
        Synced from {label} · the integration's fields are read-only; add + edit your own below
      </div>
      <ManagedUserFields ctx={ctx} />
      {kind === "google.gmail" ? <EmailThreadView ctx={ctx} /> : <ManagedRecordView ctx={ctx} />}
    </div>
  )
}
