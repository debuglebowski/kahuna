import { useLiveQuery } from "@tanstack/react-db"
import { useMutation } from "@tanstack/react-query"
import { Plus, Zap } from "lucide-react"
import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { Badge, Button, Card, Spinner, Toolbar } from "../components/ui"
import { type Automation, api } from "../lib/api"
import { automationsCollection, KEY, useRegisterCollection } from "../lib/collections"
import { AutomationEditor } from "./settings/AutomationEditor"
import { describeTrigger, summarizeActions } from "./settings/automationText"
import { useIsAdmin } from "./settings/SettingsLayout"

/** Relative "2h ago" for the run column — short by design, the editor has detail. */
const ago = (d: Date | null): string => {
  if (!d) return "never"
  const secs = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000)
  if (secs < 60) return "just now"
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * `/automations` — the list, where each row reads as its own sentence ("when
 * Deal · Stage changes → post to Slack, create task"), plus `/automations/:id`,
 * the full-page editor. One component owns both: the presence of `:id` picks.
 *
 * A TOP-LEVEL page, not a settings section — it has its own global nav slot
 * (`GLOBAL_NAV`, alongside Tasks and Members), which is where people look for it.
 * Writes are still admin-only, gated server-side and reflected here via
 * `useIsAdmin` (there is no settings Outlet context out here).
 */
export function Automations() {
  const { id } = useParams()
  const { admin } = useIsAdmin()
  const navigate = useNavigate()
  const [filter, setFilter] = useState("")
  useRegisterCollection(KEY.automations, automationsCollection)
  const { data: all = [], isLoading } = useLiveQuery((q) => q.from({ a: automationsCollection }))
  const needle = filter.trim().toLowerCase()
  const rows = needle
    ? all.filter(
        (a) =>
          a.name.toLowerCase().includes(needle) ||
          describeTrigger(a.trigger).toLowerCase().includes(needle) ||
          summarizeActions(a.actions).toLowerCase().includes(needle),
      )
    : all

  const create = useMutation({
    mutationFn: () =>
      api.createAutomation({
        name: "New automation",
        // A record.changed on no concept is the most neutral starting point: it
        // is valid, it is disabled, and every editor field is then a narrowing.
        trigger: { kind: "record.changed" },
        actions: [{ kind: "createTask", title: "Follow up on {{record.title}}" }],
      }),
    onSuccess: async (a) => {
      await automationsCollection.utils.refetch()
      navigate(`/automations/${a.id}`)
    },
  })

  if (id) return <AutomationEditor id={id} admin={admin} />
  if (isLoading) return <Spinner />

  const live = rows.filter((a) => !a.archivedAt)
  const archived = rows.filter((a) => a.archivedAt)

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold tracking-tight text-foreground">Automations</h2>
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter automations…">
        {admin && (
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            <Plus size={16} />
            New automation
          </Button>
        )}
      </Toolbar>

      {live.length === 0 && archived.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Zap size={20} className="text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No automations yet</p>
            <p className="max-w-md text-sm text-muted-foreground">
              An automation is one sentence: when something happens, if it matches, then do this.
              Create one and it starts disabled until you turn it on.
            </p>
          </div>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {live.map((a) => (
              <AutomationRow key={a.id} automation={a} />
            ))}
          </ul>
        </Card>
      )}

      {archived.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Archived
          </h3>
          <Card>
            <ul className="divide-y divide-border">
              {archived.map((a) => (
                <AutomationRow key={a.id} automation={a} />
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  )
}

/** One row: a status dot, the name, the sentence, and its run stats. */
function AutomationRow({ automation: a }: { automation: Automation }) {
  return (
    <li>
      <Link
        to={`/automations/${a.id}`}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
      >
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${a.enabled ? "bg-green-600" : "bg-border"}`}
        />
        <span className="min-w-0 shrink-0 text-sm font-medium text-foreground">{a.name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {describeTrigger(a.trigger)} → {summarizeActions(a.actions)}
        </span>
        {a.pausedReason && <Badge tone="red">paused</Badge>}
        <span className="shrink-0 text-xs text-muted-foreground">
          {a.archivedAt
            ? "archived"
            : a.enabled
              ? `${a.runCount} run${a.runCount === 1 ? "" : "s"} · ${ago(a.lastRunAt)}`
              : "off"}
        </span>
      </Link>
    </li>
  )
}
