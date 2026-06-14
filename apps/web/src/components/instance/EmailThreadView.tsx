import { useQuery } from "@tanstack/react-query"
import { api } from "../../lib/api"
import { formatDateValue } from "../../lib/dates"
import { Card, Spinner } from "../ui"
import type { InstanceCtx } from "./types"

/** The connector keys a managed concept on a `config.unique` external-id field
 *  (Gmail thread id). Resolve it structurally — never by field name. */
const externalIdOf = (ctx: InstanceCtx): string => {
  const f = ctx.fields.find((x) => x.config?.unique)
  return f ? String(ctx.instance.state[f.id] ?? "") : ""
}

/**
 * Opinionated, read-only detail view for a synced Gmail thread (concept
 * `managedBy: "google.gmail"`). Stores only metadata; the message bodies are
 * FETCHED ON DEMAND here via {@link api.getGoogleThread} (never persisted), so
 * the reader is rich without widening the stored PII surface.
 */
export function EmailThreadView({ ctx }: { ctx: InstanceCtx }) {
  const threadId = externalIdOf(ctx)
  const q = useQuery({
    queryKey: ["googleThread", threadId],
    queryFn: () => api.getGoogleThread(threadId),
    enabled: !!threadId,
  })

  if (!threadId)
    return <p className="text-sm text-muted-foreground">This record has no Gmail thread id.</p>
  if (q.isPending) return <Spinner />
  if (q.error) return <p className="text-sm text-destructive">{(q.error as Error).message}</p>

  const messages = q.data ?? []
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No messages in this thread.</p>
      ) : (
        messages.map((m) => (
          <Card key={m.id} className="max-w-2xl p-4">
            <div className="flex items-baseline justify-between gap-2">
              <span
                className="truncate text-sm font-medium text-foreground"
                title={m.from_email ?? ""}
              >
                {m.from_email ?? "—"}
              </span>
              {m.sent_at && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDateValue(m.sent_at)}
                </span>
              )}
            </div>
            {m.subject && <div className="mt-0.5 text-sm text-foreground">{m.subject}</div>}
            <div className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {m.body_text || m.snippet || ""}
            </div>
          </Card>
        ))
      )}
    </div>
  )
}
