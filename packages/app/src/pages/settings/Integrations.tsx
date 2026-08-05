import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Info, PlugZap, RefreshCw, ShieldCheck, Unplug } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge, Button, Card, CardHeader, Field, Input, Modal, Spinner } from "../../components/ui"
import { api, type IntegrationSettings, type PosthogRegion } from "../../lib/api"
import {
  ApolloLogo,
  ClayLogo,
  GoogleLogo,
  LinearLogo,
  PosthogLogo,
  SlackLogo,
} from "./integrationLogos"
import { Feedback } from "./parts"
import { useIsAdmin } from "./SettingsLayout"

/**
 * An OAuth connect URL carrying a `returnTo`. Absolute origin so the post-OAuth
 * bounce returns to the origin the user started from (e.g. the Vite dev server),
 * not the API server's :3100.
 */
const connectUrl = (path: string) => {
  const u = new URL(path, window.location.origin)
  u.searchParams.set("returnTo", `${window.location.origin}/settings/integrations`)
  return u.pathname + u.search
}

/**
 * A connected card's header actions: Sync (when the connector has one) and
 * Disconnect. Identical in every card that has it — google, posthog, linear and
 * slack shared it verbatim; apollo and clay have no sync, so they omit `onSync`.
 */
function ConnectedActions({
  onSync,
  syncing,
  onDisconnect,
  disconnecting,
  extra,
  /** Org-wide connectors are admin-only server-side; hide the action rather than
   *  offer a button that 403s. Per-user connectors (Google, the Slack user token)
   *  pass `true` — their owner manages them regardless of role. */
  canManage = true,
}: {
  onSync?: () => void
  syncing?: boolean
  onDisconnect: () => void
  disconnecting: boolean
  /** Slack's per-user disconnect sits alongside the org one. */
  extra?: ReactNode
  canManage?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      {extra}
      {onSync && (
        <Button type="button" variant="outline" onClick={onSync} disabled={syncing}>
          <RefreshCw size={15} />
          {syncing ? "Syncing..." : "Sync"}
        </Button>
      )}
      {canManage ? (
        <Button type="button" variant="outline" onClick={onDisconnect} disabled={disconnecting}>
          <Unplug size={15} />
          Disconnect
        </Button>
      ) : (
        <Badge tone="gray">Managed by an admin</Badge>
      )}
    </div>
  )
}

/** A not-yet-connected card's header actions: the data disclosure + Connect. */
function ConnectAction({
  name,
  dataImported,
  onConnect,
  canManage = true,
}: {
  name: string
  dataImported: ReactNode
  onConnect: () => void
  /** See `ConnectedActions.canManage`. */
  canManage?: boolean
}) {
  return (
    <div className="flex items-center gap-1">
      <DataImportInfo name={name}>{dataImported}</DataImportInfo>
      {canManage ? (
        <Button type="button" onClick={onConnect}>
          <PlugZap size={15} />
          Connect
        </Button>
      ) : (
        <Badge tone="gray">Admins only</Badge>
      )}
    </div>
  )
}

/**
 * A connect form's footer: the error line, Cancel, and the submit button.
 * Identical in all four key/URL-based cards apart from the submit predicate
 * (posthog/linear/apollo gate on their API key, clay on its webhook URL).
 */
function ConnectFormFooter({
  error,
  onCancel,
  pending,
  disabled,
}: {
  error?: unknown
  onCancel: () => void
  pending: boolean
  disabled: boolean
}) {
  return (
    <div className="flex items-center gap-3">
      <Feedback error={error} />
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || disabled}>
          <PlugZap size={15} />
          {pending ? "Connecting..." : "Connect"}
        </Button>
      </div>
    </div>
  )
}

/** Collapsible "Required permissions" disclosure shown on a connect form / card. */
function RequiredPermissions({ children }: { children: ReactNode }) {
  return (
    <details className="group rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-foreground">
        <ShieldCheck size={13} />
        Required permissions
        <ChevronDown size={13} className="ml-auto transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 space-y-1.5 leading-relaxed">{children}</div>
    </details>
  )
}

/** Text button + modal disclosing exactly what data the connector pulls into
 *  Kingsmaker — shown next to the initial Connect button for transparency. */
function DataImportInfo({ name, children }: { name: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant="link"
        className="h-auto gap-1 px-1 text-xs font-normal text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <Info size={14} />
        What data is imported?
      </Button>
      {open && (
        <Modal title={`${name} — what data is imported`} onClose={() => setOpen(false)}>
          <div className="space-y-3 text-sm text-muted-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1">
            {children}
          </div>
        </Modal>
      )}
    </>
  )
}

/** Per-integration copy: the scopes/setup the user must grant (permissions) and
 *  the data the connector imports/stores (dataImported). Referenced by each card. */
const INTEGRATION_INFO = {
  google: {
    name: "Google",
    permissions: (
      <p>
        Granted on Google's consent screen when you connect: <strong>Calendar</strong> (view and
        edit events and availability) and <strong>Gmail</strong> (read messages and labels;
        send/compose optional). Sensitive Gmail access requires your Google Cloud OAuth app to be{" "}
        <strong>verified</strong>.
      </p>
    ),
    dataImported: (
      <ul className="list-disc space-y-1.5 pl-4">
        <li>
          <strong>Calendar events</strong> — titles, descriptions, locations, start/end times, and
          attendee emails.
        </li>
        <li>
          <strong>Gmail messages</strong> — subjects, sender and recipient addresses, snippets, and
          full message bodies (text and HTML).
        </li>
        <li>OAuth access and refresh tokens (stored encrypted).</li>
      </ul>
    ),
  },
  posthog: {
    name: "PostHog",
    permissions: (
      <p>
        Create a <strong>Personal API key</strong> in PostHog → Settings → Personal API keys, with{" "}
        <strong>read</strong> scope for Projects, Query, and Persons. Use a personal key (
        <code>phx_…</code>), not a project/ingestion key (<code>phc_…</code>).
      </p>
    ),
    dataImported: (
      <ul className="list-disc space-y-1.5 pl-4">
        <li>
          <strong>Persons</strong> — distinct ID, email, name, all person properties, and the raw
          person record.
        </li>
        <li>Per-person event counts and first/last-seen timestamps.</li>
        <li className="text-amber-600 dark:text-amber-500">
          Person properties are customer-defined and may include phone, company, geo/IP, or device
          data — effectively a copy of your end-user identity graph.
        </li>
        <li>Your API key (stored encrypted).</li>
      </ul>
    ),
  },
  linear: {
    name: "Linear",
    permissions: (
      <p>
        A Linear personal API key grants <strong>full account access</strong> (no per-scope
        selection). For two-way sync, also create a <strong>webhook</strong> in Linear and paste its
        signing secret below.
      </p>
    ),
    dataImported: (
      <ul className="list-disc space-y-1.5 pl-4">
        <li>
          <strong>Issues</strong> — identifier, title, state, assignee, team, timestamps, and the
          full raw issue (free text may contain customer details).
        </li>
        <li>Your API key and optional webhook secret (stored encrypted).</li>
      </ul>
    ),
  },
  slack: {
    name: "Slack",
    permissions: (
      <p>
        Installs the Kingsmaker bot in your workspace (a workspace admin may need to approve).
        Requested bot scopes: <code>chat:write</code>, <code>channels:read</code>,{" "}
        <code>channels:history</code>, <code>commands</code>, <code>app_mentions:read</code>.
      </p>
    ),
    dataImported: (
      <ul className="list-disc space-y-1.5 pl-4">
        <li>Workspace bot token (encrypted), team ID, and channel names.</li>
        <li>Inbound event payloads for de-duplication — may include message text and user IDs.</li>
      </ul>
    ),
  },
  apollo: {
    name: "Apollo",
    permissions: (
      <p>
        Requires an <strong>API-enabled Apollo plan</strong>. The key grants account-level access
        for enrichment, search, and import (no granular scopes).
      </p>
    ),
    dataImported: (
      <ul className="list-disc space-y-1.5 pl-4">
        <li>
          Enriched person/company fields you request (name, title, email, company — possibly phone),
          written onto the recordVersion you enrich.
        </li>
        <li>An optional 30-day cache of those enrichment results (can be disabled).</li>
        <li>Your API key (stored encrypted).</li>
      </ul>
    ),
  },
  clay: {
    name: "Clay",
    permissions: (
      <p>
        No provider permissions to grant. Add a <strong>Webhook source</strong> to your Clay table
        and paste its URL below; Kingsmaker generates the callback secret for results.
      </p>
    ),
    dataImported: (
      <ul className="list-disc space-y-1.5 pl-4">
        <li>
          The recordVersion fields you push to Clay, and the enriched values Clay returns — written
          back onto recordVersions.
        </li>
        <li>A correlation record linking each enrichment job to its recordVersion.</li>
        <li>Your table webhook URL and optional API key (stored encrypted).</li>
      </ul>
    ),
  },
} satisfies Record<string, { name: string; permissions: ReactNode; dataImported: ReactNode }>

/**
 * The integrations page: one card per connector, each owning its own query and
 * failing in isolation. Google used to live inline here, which meant a failed
 * `googleStatus` early-returned and took all six cards down with it.
 */
export function Integrations() {
  return (
    <div className="space-y-5">
      <GoogleCard />
      <PosthogCard />
      <LinearCard />
      <SlackCard />
      <ApolloCard />
      <ClayCard />
    </div>
  )
}

function GoogleCard() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ["googleStatus"], queryFn: api.getGoogleStatus })
  const disconnect = useMutation({
    mutationFn: api.disconnectGoogle,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["googleStatus"] }),
  })
  const sync = useMutation({
    mutationFn: api.syncGoogle,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["googleStatus"] }),
  })

  if (status.isPending) return <Spinner />
  if (status.error) return <p className="text-sm text-destructive">{status.error.message}</p>

  const data = status.data
  const configured = data.configured
  const connected = data.connected

  return (
    <IntegrationCard
      name="Google"
      icon={<GoogleLogo />}
      settings={
        <IntegrationSettingsPanel
          rows={[
            {
              kind: "boolean",
              key: "googleSyncEnabled",
              label: "Sync Calendar and Gmail",
              description:
                "Applies to every member's Google connection in this organization — the connection is per person, this switch is not. Off also stops inbound push notifications and the Sync button.",
            },
            {
              kind: "boolean",
              key: "googleWatchEnabled",
              label: "Keep push subscriptions alive",
              description:
                "Renews Calendar and Gmail watches hourly so changes arrive without polling. Needs GOOGLE_WEBHOOK_BASE_URL and a Pub/Sub topic configured on the server.",
            },
          ]}
        />
      }
      configured={configured}
      connected={connected}
      disabledHint="Google is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable it."
      action={
        connected ? (
          <ConnectedActions
            onSync={() => sync.mutate()}
            syncing={sync.isPending}
            onDisconnect={() => disconnect.mutate()}
            disconnecting={disconnect.isPending}
          />
        ) : (
          <ConnectAction
            name={INTEGRATION_INFO.google.name}
            dataImported={INTEGRATION_INFO.google.dataImported}
            onConnect={() => {
              window.location.href = connectUrl("/api/integrations/google/connect")
            }}
          />
        )
      }
    >
      {connected ? (
        <div className="space-y-4 p-6">
          {(data.email || data.lastSyncAt) && (
            <div className="flex flex-wrap items-center gap-2">
              {data.email && <span className="text-sm text-muted-foreground">{data.email}</span>}
              {data.lastSyncAt && (
                <span className="text-sm text-muted-foreground">
                  Synced {new Date(data.lastSyncAt).toLocaleString()}
                </span>
              )}
            </div>
          )}
          <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
            <div>
              Calendar watch:{" "}
              {data.calendarWatchExpiresAt
                ? new Date(data.calendarWatchExpiresAt).toLocaleString()
                : "not active"}
            </div>
            <div>
              Gmail watch:{" "}
              {data.gmailWatchExpiresAt
                ? new Date(data.gmailWatchExpiresAt).toLocaleString()
                : "not active"}
            </div>
          </div>
          {data.lastError && <p className="text-sm text-destructive">{data.lastError}</p>}
          <Feedback error={disconnect.error ?? sync.error} />
        </div>
      ) : (
        <div className="p-6">
          <RequiredPermissions>{INTEGRATION_INFO.google.permissions}</RequiredPermissions>
        </div>
      )}
    </IntegrationCard>
  )
}

/**
 * Reusable connector card shell — the scaffold every non-Google integration
 * (PostHog, and later Linear/Slack/Apollo/Clay) renders into. Shows the
 * Connected / Not connected badge when `configured`, or a "Disabled" badge when
 * the integration can't be enabled on this server. The body (`children`) is the
 * caller's: a connect form when disconnected, status + actions when connected.
 */
export function IntegrationCard({
  name,
  icon,
  configured,
  connected,
  disabledHint,
  action,
  children,
  settings,
}: {
  name: string
  icon: ReactNode
  configured: boolean
  connected: boolean
  disabledHint?: string
  action?: ReactNode
  children?: ReactNode
  /** Per-org toggles. Only rendered when connected — a toggle on a connector
   *  nobody has set up is noise, and it has nothing to act on. */
  settings?: ReactNode
}) {
  const hasBody = Boolean(children)
  return (
    <Card className={!configured ? "opacity-60" : undefined}>
      <CardHeader
        className={!hasBody ? "min-h-16 border-b-0" : undefined}
        title={
          <span className="flex items-center gap-2">
            {icon}
            {name}
            {configured && (
              <Badge tone={connected ? "green" : "gray"}>
                {connected ? "Connected" : "Not connected"}
              </Badge>
            )}
          </span>
        }
        action={
          !configured ? (
            <span title={disabledHint}>
              <Badge tone="gray">Disabled</Badge>
            </span>
          ) : (
            action
          )
        }
      />
      {configured ? children : null}
      {configured && connected ? settings : null}
    </Card>
  )
}

type BooleanSettingKey = {
  [K in keyof IntegrationSettings]: IntegrationSettings[K] extends boolean ? K : never
}[keyof IntegrationSettings]
type NumberSettingKey = {
  [K in keyof IntegrationSettings]: IntegrationSettings[K] extends number ? K : never
}[keyof IntegrationSettings]

type SettingRow =
  | { kind: "boolean"; key: BooleanSettingKey; label: string; description: string }
  | {
      kind: "number"
      key: NumberSettingKey
      label: string
      description: string
      unit: string
      min: number
    }

/**
 * The per-org settings block on a connected card.
 *
 * One component for all five connectors: the rows differ, the mechanics don't.
 * Every card calls the same `["integrationSettings"]` query — react-query dedupes
 * them into ONE request, so this stays a single fetch for the page.
 *
 * Admin-only, and hidden entirely for everyone else rather than shown disabled:
 * a member has no path to change these, and the connector cards already hide
 * actions the same way (`canManage` on ConnectedActions).
 */
function IntegrationSettingsPanel({ rows }: { rows: ReadonlyArray<SettingRow> }) {
  const qc = useQueryClient()
  const settings = useQuery({
    queryKey: ["integrationSettings"],
    queryFn: api.getIntegrationSettings,
  })
  const [bools, setBools] = useState<Record<string, boolean>>({})
  // Numbers are held as typed TEXT, not parsed on every keystroke: parsing live
  // means clearing the field to retype yields "" -> 0, which either snaps the
  // input to 0 or (below `min`) silently refuses the edit and looks stuck.
  const [nums, setNums] = useState<Record<string, string>>({})

  const save = useMutation({
    mutationFn: () => {
      const patch: Record<string, boolean | number> = { ...bools }
      for (const [k, raw] of Object.entries(nums)) {
        const n = Number(raw)
        if (raw.trim() !== "" && Number.isInteger(n)) patch[k] = n
      }
      return api.updateIntegrationSettings(patch)
    },
    onSuccess: () => {
      setBools({})
      setNums({})
      qc.invalidateQueries({ queryKey: ["integrationSettings"] })
    },
  })

  if (!settings.data?.canEdit) return null
  const effective = settings.data.effective
  const boolValue = (k: BooleanSettingKey) => bools[k] ?? effective[k]
  const numValue = (k: NumberSettingKey) => nums[k] ?? String(effective[k])

  // A number row is only dirty once it parses AND differs — a half-typed or
  // empty field must not arm Save with a value the server would reject.
  const numDirty = rows.some((r) => {
    if (r.kind !== "number") return false
    const raw = nums[r.key]
    if (raw === undefined || raw.trim() === "") return false
    const n = Number(raw)
    return Number.isInteger(n) && n >= r.min && n !== effective[r.key]
  })
  const numInvalid = rows.some((r) => {
    if (r.kind !== "number") return false
    const raw = nums[r.key]
    if (raw === undefined) return false
    const n = Number(raw)
    return raw.trim() === "" || !Number.isInteger(n) || n < r.min
  })
  const dirty = Object.keys(bools).length > 0 || numDirty

  return (
    <div className="space-y-4 border-t border-border p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">Settings</span>
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || !dirty || numInvalid}
          variant="secondary"
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>

      {rows.map((row) =>
        row.kind === "boolean" ? (
          <Label key={row.key} className="flex items-start gap-3 font-normal">
            <Checkbox
              className="mt-0.5"
              checked={boolValue(row.key)}
              onCheckedChange={(c) => setBools((d) => ({ ...d, [row.key]: c === true }))}
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium text-foreground">{row.label}</span>
              <span className="block text-sm text-muted-foreground">{row.description}</span>
            </span>
          </Label>
        ) : (
          <Field key={row.key} label={row.label} hint={row.description}>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={row.min}
                className="w-32"
                value={numValue(row.key)}
                onChange={(e) => setNums((d) => ({ ...d, [row.key]: e.target.value }))}
              />
              <span className="text-sm text-muted-foreground">{row.unit}</span>
            </div>
          </Field>
        ),
      )}

      <Feedback ok={save.isSuccess} okText="Saved." error={save.error} />
    </div>
  )
}

const REGION_OPTIONS: ReadonlyArray<{ value: PosthogRegion; label: string }> = [
  { value: "us", label: "US Cloud (us.posthog.com)" },
  { value: "eu", label: "EU Cloud (eu.posthog.com)" },
  { value: "custom", label: "Self-hosted" },
]

function PosthogCard() {
  const qc = useQueryClient()
  const { admin } = useIsAdmin()
  const status = useQuery({ queryKey: ["posthogStatus"], queryFn: api.getPosthogStatus })
  const detail = INTEGRATION_INFO.posthog
  const [apiKey, setApiKey] = useState("")
  const [region, setRegion] = useState<PosthogRegion>("us")
  const [host, setHost] = useState("")
  const [projectId, setProjectId] = useState("")
  const [connecting, setConnecting] = useState(false)

  const connect = useMutation({
    mutationFn: () =>
      api.connectPosthog({
        apiKey: apiKey.trim(),
        region,
        host: region === "custom" ? host.trim() : undefined,
        projectId: projectId.trim() || undefined,
      }),
    onSuccess: () => {
      setApiKey("")
      setConnecting(false)
      qc.invalidateQueries({ queryKey: ["posthogStatus"] })
    },
  })
  const disconnect = useMutation({
    mutationFn: api.disconnectPosthog,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["posthogStatus"] }),
  })
  const sync = useMutation({
    mutationFn: api.syncPosthog,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["posthogStatus"] }),
  })

  if (status.isPending) return <Spinner />
  if (status.error) return <p className="text-sm text-destructive">{status.error.message}</p>

  const data = status.data
  const connected = data.connected

  return (
    <IntegrationCard
      name="PostHog"
      icon={<PosthogLogo />}
      settings={
        <IntegrationSettingsPanel
          rows={[
            {
              kind: "boolean",
              key: "posthogSyncEnabled",
              label: "Sync people and events",
              description:
                "Off also makes inbound webhooks a no-op (still acknowledged, so PostHog does not disable the destination) and disables the Sync button.",
            },
            {
              kind: "number",
              key: "analyticsCacheTtlMs",
              label: "Analytics cache",
              description:
                "How long an analytics widget reuses a result before querying PostHog again. 0 disables caching. Lives here because analytics runs on this connection.",
              unit: "ms",
              min: 0,
            },
          ]}
        />
      }
      configured
      connected={connected}
      action={
        connected ? (
          <ConnectedActions
            onSync={() => sync.mutate()}
            syncing={sync.isPending}
            onDisconnect={() => disconnect.mutate()}
            disconnecting={disconnect.isPending}
            canManage={admin}
          />
        ) : connecting ? undefined : (
          <ConnectAction
            name={detail.name}
            dataImported={detail.dataImported}
            onConnect={() => setConnecting(true)}
            canManage={admin}
          />
        )
      }
    >
      {connected ? (
        <div className="space-y-3 p-6 text-sm text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-foreground">
              {data.projectName ? `${data.projectName} (${data.projectId})` : data.projectId}
            </span>
            {data.host && <span>· {data.host}</span>}
            {data.lastSyncAt && <span>· Synced {new Date(data.lastSyncAt).toLocaleString()}</span>}
          </div>
          {data.webhookUrl && (
            <div className="space-y-1 break-all">
              <div>
                Webhook receiver: <code className="text-xs">{data.webhookUrl}</code>
              </div>
              {/* The token authenticates this endpoint, so it goes in a header
                  rather than the URL (a query string lands in proxy logs). Only
                  an admin gets it back from the API. */}
              {data.webhookToken && (
                <div>
                  Add header{" "}
                  <code className="text-xs">
                    {data.webhookTokenHeader ?? "x-km-webhook-token"}: {data.webhookToken}
                  </code>
                </div>
              )}
            </div>
          )}
          {data.lastError && <p className="text-destructive">{data.lastError}</p>}
          <Feedback error={disconnect.error ?? sync.error} />
        </div>
      ) : !connecting ? null : (
        <form
          className="space-y-4 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            connect.mutate()
          }}
        >
          <RequiredPermissions>{detail.permissions}</RequiredPermissions>
          <Field
            label="Personal or project API key"
            hint="A PostHog Personal API key (phx_…) scoped to project:read, person:read, and query:read — Connect validates with project:read; Sync pulls persons (person:read) + events (query:read). A project ingestion key (phc_…) won't work. Stored encrypted."
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="phx_..."
              autoComplete="off"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Region"
              hint="Where your PostHog project is hosted — US or EU Cloud, or Self-hosted to enter a custom host URL below."
            >
              <Select value={region} onValueChange={(v) => setRegion(v as PosthogRegion)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REGION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Project ID (optional)"
              hint="The PostHog project to sync. Leave blank to use the first project your key can access."
            >
              <Input
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="defaults to first project"
              />
            </Field>
          </div>
          {region === "custom" && (
            <Field
              label="Self-hosted host"
              hint="Base URL of your self-hosted PostHog recordVersion, e.g. https://posthog.example.com."
            >
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="https://posthog.example.com"
              />
            </Field>
          )}
          <ConnectFormFooter
            error={connect.error}
            onCancel={() => setConnecting(false)}
            pending={connect.isPending}
            disabled={!apiKey.trim()}
          />
        </form>
      )}
    </IntegrationCard>
  )
}

function LinearCard() {
  const qc = useQueryClient()
  const { admin } = useIsAdmin()
  const status = useQuery({ queryKey: ["linearStatus"], queryFn: api.getLinearStatus })
  const detail = INTEGRATION_INFO.linear
  const [apiKey, setApiKey] = useState("")
  const [webhookSecret, setWebhookSecret] = useState("")
  const [connecting, setConnecting] = useState(false)

  const connect = useMutation({
    mutationFn: () =>
      api.connectLinear({
        apiKey: apiKey.trim(),
        webhookSecret: webhookSecret.trim() || undefined,
      }),
    onSuccess: () => {
      setApiKey("")
      setWebhookSecret("")
      setConnecting(false)
      qc.invalidateQueries({ queryKey: ["linearStatus"] })
    },
  })
  const disconnect = useMutation({
    mutationFn: api.disconnectLinear,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["linearStatus"] }),
  })
  const sync = useMutation({
    mutationFn: api.syncLinear,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["linearStatus"] }),
  })

  if (status.isPending) return <Spinner />
  if (status.error) return <p className="text-sm text-destructive">{status.error.message}</p>

  const data = status.data
  const connected = data.connected

  return (
    <IntegrationCard
      name="Linear"
      icon={<LinearLogo />}
      settings={
        <IntegrationSettingsPanel
          rows={[
            {
              kind: "boolean",
              key: "linearSyncEnabled",
              label: "Mirror issues",
              description:
                "Off also makes inbound webhooks a no-op (still acknowledged and still signature-checked) and disables the Sync button.",
            },
          ]}
        />
      }
      configured
      connected={connected}
      action={
        connected ? (
          <ConnectedActions
            onSync={() => sync.mutate()}
            syncing={sync.isPending}
            onDisconnect={() => disconnect.mutate()}
            disconnecting={disconnect.isPending}
            canManage={admin}
          />
        ) : connecting ? undefined : (
          <ConnectAction
            name={detail.name}
            dataImported={detail.dataImported}
            onConnect={() => setConnecting(true)}
            canManage={admin}
          />
        )
      }
    >
      {connected ? (
        <div className="space-y-3 p-6 text-sm text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {data.viewerName && <span className="text-foreground">{data.viewerName}</span>}
            {data.lastSyncAt && <span>· Synced {new Date(data.lastSyncAt).toLocaleString()}</span>}
          </div>
          {data.webhookUrl && (
            <div className="space-y-1 break-all">
              <div>
                Webhook receiver: <code className="text-xs">{data.webhookUrl}</code>
                {!data.webhookConfigured && (
                  <span className="ml-1 text-amber-600">
                    (add a signing secret to accept deliveries)
                  </span>
                )}
              </div>
              {/* Routing token as a header, not a query param — see PostHog above.
                  For Linear the HMAC signature is the real authenticator; this
                  only selects the connection. */}
              {data.webhookToken && (
                <div>
                  Add header{" "}
                  <code className="text-xs">
                    {data.webhookTokenHeader ?? "x-km-webhook-token"}: {data.webhookToken}
                  </code>
                </div>
              )}
            </div>
          )}
          {data.lastError && <p className="text-destructive">{data.lastError}</p>}
          <Feedback error={disconnect.error ?? sync.error} />
        </div>
      ) : !connecting ? null : (
        <form
          className="space-y-4 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            connect.mutate()
          }}
        >
          <RequiredPermissions>{detail.permissions}</RequiredPermissions>
          <Field
            label="Personal API key"
            hint="A Linear personal API key (lin_api_…), created in Linear → Settings → Security & access → API. Used to read issues and push status updates. Stored encrypted."
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="lin_api_..."
              autoComplete="off"
            />
          </Field>
          <Field
            label="Webhook signing secret (optional)"
            hint="Only needed if you want Linear to push issue changes into Kingsmaker — it verifies the signature on incoming Linear webhooks. Leave blank for one-way (Kingsmaker → Linear) sync."
          >
            <Input
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder="lin_wh_..."
              autoComplete="off"
            />
          </Field>
          <ConnectFormFooter
            error={connect.error}
            onCancel={() => setConnecting(false)}
            pending={connect.isPending}
            disabled={!apiKey.trim()}
          />
        </form>
      )}
    </IntegrationCard>
  )
}

function SlackCard() {
  const qc = useQueryClient()
  const { admin } = useIsAdmin()
  const status = useQuery({ queryKey: ["slackStatus"], queryFn: api.getSlackStatus })
  const disconnect = useMutation({
    mutationFn: api.disconnectSlack,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slackStatus"] }),
  })
  const sync = useMutation({
    mutationFn: api.syncSlack,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slackStatus"] }),
  })
  const disconnectUser = useMutation({
    mutationFn: api.disconnectSlackUser,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["slackStatus"] }),
  })

  if (status.isPending) return <Spinner />
  if (status.error) return <p className="text-sm text-destructive">{status.error.message}</p>

  const data = status.data
  const configured = data.configured
  const connected = data.connected
  const userConnected = Boolean(data.user?.connected)

  return (
    <IntegrationCard
      name="Slack"
      icon={<SlackLogo />}
      settings={
        <IntegrationSettingsPanel
          rows={[
            {
              kind: "boolean",
              key: "slackSyncEnabled",
              label: "Sync channels",
              description: "Off also disables the Sync button.",
            },
          ]}
        />
      }
      configured={configured}
      connected={connected}
      disabledHint="Slack is not configured on this server. Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET to enable it."
      action={
        connected ? (
          <ConnectedActions
            onSync={() => sync.mutate()}
            syncing={sync.isPending}
            onDisconnect={() => disconnect.mutate()}
            disconnecting={disconnect.isPending}
            canManage={admin}
          />
        ) : (
          <div className="flex items-center gap-1">
            <DataImportInfo name="Slack">{INTEGRATION_INFO.slack.dataImported}</DataImportInfo>
            {/* The workspace BOT install is admin-only (per-user Slack connect,
                offered once the bot exists, stays open to every member). */}
            {admin ? (
              <Button
                type="button"
                onClick={() =>
                  (window.location.href = connectUrl("/api/integrations/slack/connect"))
                }
              >
                <PlugZap size={15} />
                Connect
              </Button>
            ) : (
              <Badge tone="gray">Admins only</Badge>
            )}
          </div>
        )
      }
    >
      {connected ? (
        <div className="space-y-3 p-6 text-sm text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {data.teamName && <span className="text-foreground">{data.teamName}</span>}
            {data.teamId && <span>· {data.teamId}</span>}
            {data.lastSyncAt && <span>· Synced {new Date(data.lastSyncAt).toLocaleString()}</span>}
          </div>
          {data.eventsUrl && (
            <div className="break-all">
              Event subscriptions URL: <code className="text-xs">{data.eventsUrl}</code>
            </div>
          )}
          {data.commandsUrl && (
            <div className="break-all">
              Slash command URL: <code className="text-xs">{data.commandsUrl}</code>
            </div>
          )}
          {data.interactivityUrl && (
            <div className="break-all">
              Interactivity URL: <code className="text-xs">{data.interactivityUrl}</code>
            </div>
          )}
          {data.lastError && <p className="text-destructive">{data.lastError}</p>}
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {userConnected ? (
              <>
                <span className="text-foreground">
                  Acting as your account
                  {data.user?.slackUserName ? ` · @${data.user.slackUserName}` : ""}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => disconnectUser.mutate()}
                  disabled={disconnectUser.isPending}
                >
                  <Unplug size={14} />
                  Disconnect my account
                </Button>
              </>
            ) : (
              <>
                <span>Connect your own Slack account to let Kingsmaker act as you.</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    (window.location.href = connectUrl("/api/integrations/slack/user/connect"))
                  }
                >
                  <PlugZap size={14} />
                  Connect my account
                </Button>
              </>
            )}
          </div>
          <Feedback error={disconnect.error ?? sync.error ?? disconnectUser.error} />
        </div>
      ) : (
        <div className="p-6">
          <RequiredPermissions>{INTEGRATION_INFO.slack.permissions}</RequiredPermissions>
        </div>
      )}
    </IntegrationCard>
  )
}

/**
 * Apollo.io — a key-based connector (like PostHog), so `configured` is always
 * true. Connect stores an encrypted org-level API key; once connected, the card
 * surfaces how the connector is used (on-demand enrich / search / import) and
 * the count of enrichment fields available to map. Per-record version enrichment is
 * driven from the record version Details tile (the enrich route + client live here;
 * that UI affordance is a deferred follow-up).
 */
function ApolloCard() {
  const qc = useQueryClient()
  const { admin } = useIsAdmin()
  const status = useQuery({ queryKey: ["apolloStatus"], queryFn: api.getApolloStatus })
  const detail = INTEGRATION_INFO.apollo
  const [apiKey, setApiKey] = useState("")
  const [connecting, setConnecting] = useState(false)

  const connect = useMutation({
    mutationFn: () => api.connectApollo(apiKey.trim()),
    onSuccess: () => {
      setApiKey("")
      setConnecting(false)
      qc.invalidateQueries({ queryKey: ["apolloStatus"] })
    },
  })
  const disconnect = useMutation({
    mutationFn: api.disconnectApollo,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["apolloStatus"] }),
  })

  if (status.isPending) return <Spinner />
  if (status.error) return <p className="text-sm text-destructive">{status.error.message}</p>

  const data = status.data
  const connected = data.connected

  return (
    <IntegrationCard
      name="Apollo"
      icon={<ApolloLogo />}
      settings={
        <IntegrationSettingsPanel
          rows={[
            {
              kind: "boolean",
              key: "apolloEnrichCacheEnabled",
              label: "Cache enrichment results",
              description:
                "Reuses a previous lookup instead of spending an Apollo credit. Turning it off does not purge what is already cached — disconnecting does.",
            },
            {
              kind: "number",
              key: "apolloEnrichCacheTtlDays",
              label: "Cache lifetime",
              description: "How long a cached person stays fresh before Apollo is asked again.",
              unit: "days",
              min: 1,
            },
          ]}
        />
      }
      configured
      connected={connected}
      action={
        connected ? (
          <ConnectedActions
            onDisconnect={() => disconnect.mutate()}
            disconnecting={disconnect.isPending}
            canManage={admin}
          />
        ) : connecting ? undefined : (
          <ConnectAction
            name={detail.name}
            dataImported={detail.dataImported}
            onConnect={() => setConnecting(true)}
            canManage={admin}
          />
        )
      }
    >
      {connected ? (
        <div className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>
            Enrich recordVersions, search for people, and import leads on demand.{" "}
            {data.enrichmentFields?.length
              ? `${data.enrichmentFields.length} enrichment fields available to map.`
              : null}
          </p>
          {data.lastValidatedAt && (
            <div>Key validated {new Date(data.lastValidatedAt).toLocaleString()}</div>
          )}
          {data.lastError && <p className="text-destructive">{data.lastError}</p>}
          <Feedback error={disconnect.error} />
        </div>
      ) : !connecting ? null : (
        <form
          className="space-y-4 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            connect.mutate()
          }}
        >
          <RequiredPermissions>{detail.permissions}</RequiredPermissions>
          <Field
            label="API key"
            hint="Your Apollo.io API key (requires an API-enabled plan), from Apollo → Settings → Integrations → API. Used for on-demand enrichment, search, and import. Stored encrypted."
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Apollo API key"
              autoComplete="off"
            />
          </Field>
          <ConnectFormFooter
            error={connect.error}
            onCancel={() => setConnecting(false)}
            pending={connect.isPending}
            disabled={!apiKey.trim()}
          />
        </form>
      )}
    </IntegrationCard>
  )
}

/**
 * Clay — an ASYNC, webhook/table-centric connector, so `configured` is always
 * true (no server OAuth gate). Connect stores the encrypted Clay table-webhook
 * URL + a KM-generated callback secret; once connected the card surfaces the
 * callback URL the operator pastes into Clay's "send result back" action. The
 * round-trip (push record version → Clay enriches → callback writes fields back) is
 * driven from the record version Details tile (the enrich route + client live here;
 * that "Send to Clay" UI affordance is a deferred follow-up).
 */
function ClayCard() {
  const qc = useQueryClient()
  const { admin } = useIsAdmin()
  const status = useQuery({ queryKey: ["clayStatus"], queryFn: api.getClayStatus })
  const detail = INTEGRATION_INFO.clay
  const [tableWebhookUrl, setTableWebhookUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [connecting, setConnecting] = useState(false)

  const connect = useMutation({
    mutationFn: () =>
      api.connectClay({
        tableWebhookUrl: tableWebhookUrl.trim(),
        apiKey: apiKey.trim() || undefined,
      }),
    onSuccess: () => {
      setTableWebhookUrl("")
      setApiKey("")
      setConnecting(false)
      qc.invalidateQueries({ queryKey: ["clayStatus"] })
    },
  })
  const disconnect = useMutation({
    mutationFn: api.disconnectClay,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["clayStatus"] }),
  })

  if (status.isPending) return <Spinner />
  if (status.error) return <p className="text-sm text-destructive">{status.error.message}</p>

  const data = status.data
  const connected = data.connected

  return (
    <IntegrationCard
      name="Clay"
      icon={<ClayLogo />}
      configured
      connected={connected}
      action={
        connected ? (
          <ConnectedActions
            onDisconnect={() => disconnect.mutate()}
            disconnecting={disconnect.isPending}
            canManage={admin}
          />
        ) : connecting ? undefined : (
          <ConnectAction
            name={detail.name}
            dataImported={detail.dataImported}
            onConnect={() => setConnecting(true)}
            canManage={admin}
          />
        )
      }
    >
      {connected ? (
        <div className="space-y-3 p-6 text-sm text-muted-foreground">
          <p>
            Push recordVersions into your Clay table for enrichment; enriched rows post back
            automatically. Net-new Clay rows{" "}
            {data.newRowAutoCreate ? "create recordVersions" : "are queued for review"}.
          </p>
          {data.callbackUrl && (
            <div className="space-y-1 break-all">
              <div>
                Callback URL (paste into Clay): <code className="text-xs">{data.callbackUrl}</code>
              </div>
              {/* The secret is what authenticates the callback, so it is sent as a
                  header instead of riding in the URL — a query string is recorded
                  by our proxy logs AND by Clay's request history. Admin-only. */}
              {data.callbackSecret && (
                <div>
                  Add header{" "}
                  <code className="text-xs">
                    {data.callbackSecretHeader ?? "x-clay-secret"}: {data.callbackSecret}
                  </code>
                </div>
              )}
            </div>
          )}
          {data.lastValidatedAt && (
            <div>Connected {new Date(data.lastValidatedAt).toLocaleString()}</div>
          )}
          {data.lastError && <p className="text-destructive">{data.lastError}</p>}
          <Feedback error={disconnect.error} />
        </div>
      ) : !connecting ? null : (
        <form
          className="space-y-4 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            connect.mutate()
          }}
        >
          <RequiredPermissions>{detail.permissions}</RequiredPermissions>
          <Field
            label="Clay table webhook URL"
            hint="The webhook URL of the Clay table that receives rows pushed from Kingsmaker — in Clay, add a 'Webhook' source to the table and paste its URL here. Stored encrypted."
          >
            <Input
              value={tableWebhookUrl}
              onChange={(e) => setTableWebhookUrl(e.target.value)}
              placeholder="https://api.clay.com/v3/sources/webhook/..."
              autoComplete="off"
            />
          </Field>
          <Field
            label="API key (optional)"
            hint="Optional Clay API key, stored encrypted. Only needed for Clay endpoints that require key auth — the table webhook push works without it."
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Clay API key"
              autoComplete="off"
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            KM pushes rows to the webhook URL with a correlation id and generates a callback secret;
            both the URL and key are stored encrypted. After connecting, paste the callback URL
            shown here into Clay's result action.
          </p>
          <ConnectFormFooter
            error={connect.error}
            onCancel={() => setConnecting(false)}
            pending={connect.isPending}
            disabled={!tableWebhookUrl.trim()}
          />
        </form>
      )}
    </IntegrationCard>
  )
}
