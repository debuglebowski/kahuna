import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Badge, Button, Card, CardHeader, Input, Spinner } from "../../components/ui"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select"
import {
  type AccessActionName,
  type AccessResourceType,
  api,
  type ExplainAccess,
} from "../../lib/api"
import { Feedback } from "./parts"

/** Every grantable action, in the same escalating order the role editor uses. */
const ACTIONS: ReadonlyArray<{ id: AccessActionName; label: string }> = [
  { id: "view", label: "View" },
  { id: "create", label: "Create" },
  { id: "edit", label: "Edit" },
  { id: "archive", label: "Archive" },
  { id: "delete", label: "Delete" },
  { id: "share", label: "Share" },
  { id: "configure", label: "Configure" },
]

/** Every resource type the cascade can decide about, plain-English labels. Not
 *  imported from `Roles.tsx` (its `RESOURCE_GROUPS` is private to that page's
 *  grid, and deliberately excludes ungridded types) — this tool needs all ten,
 *  including `role`, which is exactly what Layer 0 exists to guarantee. */
const RESOURCE_TYPES: ReadonlyArray<{ id: AccessResourceType; label: string }> = [
  { id: "concept", label: "Concepts" },
  { id: "record", label: "Records" },
  { id: "dashboard", label: "Dashboards" },
  { id: "view", label: "Sidebar views" },
  { id: "task", label: "Tasks" },
  { id: "note", label: "Notes" },
  { id: "automation", label: "Automations" },
  { id: "member", label: "Members" },
  { id: "role", label: "Roles & permissions" },
  { id: "org", label: "Organisation" },
]

const verdictTone = (v: "allow" | "deny" | "silent") =>
  v === "allow" ? "green" : v === "deny" ? "red" : "gray"

/**
 * The ordered layer trace for one (resource, action) question — `explainDecision`
 * made visible. Every layer the actor holds a rule in is shown, in the order the
 * cascade actually walks it, with the one that decided the outcome highlighted.
 * A silent layer is not hidden: seeing "Ops: silent" is what proves a role was
 * consulted and had nothing to say, rather than never being considered at all.
 */
function ExplainTrace({ result }: { result: ExplainAccess }) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={result.outcome ? "green" : "red"}>
          {result.outcome ? "Allowed" : "Denied"}
        </Badge>
        <span className="text-muted-foreground">
          {result.action} on {result.resourceType}
          {result.resourceId ? ` #${result.resourceId.slice(0, 8)}` : " (any)"}
        </span>
      </div>

      {result.unrestricted ? (
        <p className="text-sm text-muted-foreground">
          Resolved by the engine's own unrestricted scope — no layer was walked.
        </p>
      ) : result.layers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No layer you hold says anything about this resource — the outcome is the resource's own
          default ({result.fallback ? "open" : "closed"}).
        </p>
      ) : (
        <div className="divide-y rounded-md border">
          {result.layers.map((l) => (
            <div
              // `precedence` is unique within one trace — `tiersOf` groups by it.
              key={l.precedence}
              className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm ${
                l.decided ? "bg-muted/50" : ""
              }`}
            >
              <span className="font-medium">{l.label}</span>
              <Badge tone={verdictTone(l.verdict)}>{l.verdict}</Badge>
              {l.decided && <Badge tone="blue">decided this</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">
                precedence {l.precedence}
              </span>
            </div>
          ))}
        </div>
      )}

      {result.decidedByFallback && result.layers.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Every layer stayed silent — fell back to the resource's own default (
          {result.fallback ? "open" : "closed"}).
        </p>
      )}
    </div>
  )
}

/** The interactive half of the report: pick a resource type + action and see the
 *  ordered layer trace behind that specific answer, instead of scanning the full
 *  rule list for it. */
function ExplainTool({ userId }: { userId?: string }) {
  const [resourceType, setResourceType] = useState<AccessResourceType>("concept")
  const [action, setAction] = useState<AccessActionName>("view")
  const [resourceId, setResourceId] = useState("")

  const m = useMutation({
    mutationFn: () =>
      api.explainAccess({
        userId,
        resourceType,
        action,
        resourceId: resourceId.trim() || undefined,
      }),
  })

  return (
    <div className="space-y-3">
      <span className="text-sm font-medium">Explain a decision</span>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={resourceType}
          onValueChange={(v) => setResourceType(v as AccessResourceType)}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESOURCE_TYPES.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={action} onValueChange={(v) => setAction(v as AccessActionName)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTIONS.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="min-w-[10rem] flex-1"
          placeholder="Resource id (optional — any)"
          value={resourceId}
          onChange={(e) => setResourceId(e.target.value)}
        />
        <Button size="sm" onClick={() => m.mutate()} disabled={m.isPending}>
          {m.isPending ? "Checking…" : "Check"}
        </Button>
      </div>
      {m.error ? <Feedback error={m.error} /> : null}
      {m.data ? <ExplainTrace result={m.data} /> : null}
    </div>
  )
}

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
          The roles you hold and the rules they grant, in the order the cascade resolves them. A
          layer held first can override one held later.
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
                  {/* WHAT grants it, and which LAYER it resolves in — the question
                      the report exists to answer. */}
                  <span className="ml-auto text-xs text-muted-foreground">{r.layerLabel}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <ExplainTool userId={userId} />
      </div>
    </Card>
  )
}
