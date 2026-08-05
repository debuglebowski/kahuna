import { useQuery } from "@tanstack/react-query"
import { Badge, Card, CardHeader, Spinner } from "../../components/ui"
import { api } from "../../lib/api"
import { Feedback } from "./parts"

/**
 * "What can I see and do, and what grants it?" — the self-serve access report.
 *
 * THE POINT of shipping this rather than a "view as this member" preview: a member who
 * cannot see something answers "why?" themselves instead of filing a ticket with an
 * admin. It is also far cheaper than a second way to run the whole app.
 *
 * Readable by ANYONE about themselves (no `configure`); asking about someone else is
 * admin-only and lives on their member page.
 */
export function MyAccess({ userId }: { userId?: string }) {
  const q = useQuery({
    queryKey: ["effectiveAccess", userId ?? "me"],
    queryFn: () => api.effectiveAccess(userId),
  })

  if (q.isPending) return <Spinner />
  if (q.error) return <Feedback error={(q.error as Error).message} />
  const data = q.data
  if (!data) return null

  return (
    <Card>
      <CardHeader title="Access" />
      <div className="space-y-4 p-4 pt-0">
        <p className="text-sm text-muted-foreground">
          The roles you hold and the rules they grant. A deny always wins.
        </p>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">Roles</span>
          <div className="flex flex-wrap gap-1.5">
            {data.roles.length === 0 ? (
              <span className="text-sm text-muted-foreground">
                No roles assigned — you see what every member sees.
              </span>
            ) : (
              data.roles.map((r) => (
                <Badge key={r.id} tone={r.key === null ? "blue" : "gray"}>
                  {r.name}
                </Badge>
              ))
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <span className="text-sm font-medium">Rules that apply to you</span>
          {data.rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None. Everything you can reach comes from each record's own default visibility.
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {data.rules.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <Badge tone={r.effect === "deny" ? "red" : "green"}>{r.effect}</Badge>
                  <span className="font-medium">{r.actions.join(", ")}</span>
                  <span className="text-muted-foreground">on</span>
                  <span>{r.resourceType}</span>
                  {r.resourceId ? (
                    <span className="text-muted-foreground">#{r.resourceId.slice(0, 8)}</span>
                  ) : (
                    <span className="text-muted-foreground">(any)</span>
                  )}
                  {r.condition ? <Badge tone="amber">conditional</Badge> : null}
                  {/* WHAT grants it — the question the report exists to answer. A null
                      role means it was shared with you directly. */}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {r.viaRoleName ?? (r.viaRoleId ? "a role" : "shared with you")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
