import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import {
  type DashboardBody,
  type FieldConfig,
  type FieldKind,
  type GraphLayout,
  type InstanceViewLayout,
  type InstanceViewPrefsBody,
  KingsmakerRpcs,
  type RichTextEnvelope,
  type SidebarViewBody,
  type TaskStatusCategory,
} from "../../rpc/contract"

export type {
  AnnotationField,
  AnnotationType,
  Attachment,
  Concept,
  ConceptGraph,
  ConceptGraphEdge,
  ConceptGraphNode,
  Dashboard,
  DashboardBody,
  DashboardWidget,
  DeactivatedMember,
  FeedItem,
  Field,
  FieldConfig,
  FieldKind,
  GraphLayout,
  Instance,
  InstanceDetail,
  InstancePick,
  InstanceViewLayout,
  InstanceViewPrefs,
  InstanceViewPrefsBody,
  InstanceViewTile,
  Item,
  Label,
  Note,
  RelatedInstance,
  Relation,
  RichTextEnvelope,
  SidebarCondition,
  SidebarSection,
  SidebarView,
  SidebarViewBody,
  Task,
  TaskPriority,
  TaskStatus,
  TaskStatusCategory,
  TaskSubjectRef,
  VersionStatus,
} from "../../rpc/contract"

/** Computed-field shapes (carried inside an instance's `state`). */
export interface DecayValue {
  readonly days: number | null
  readonly band: "fresh" | "warm" | "cooling" | "cold"
}
export interface MomentumValue {
  readonly label: "heating" | "steady" | "cooling"
  readonly recent: number
  readonly prior: number
}

// Build the RPC client once: fetch transport + ndjson, pointed at /api/rpc.
const ProtocolLive = RpcClient.layerProtocolHttp({ url: "/api/rpc" }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
)

const makeClient = RpcClient.make(KingsmakerRpcs)
type Client = Effect.Effect.Success<typeof makeClient>

class ApiClient extends Context.Tag("kingsmaker/ApiClient")<ApiClient, Client>() {}

const runtime = ManagedRuntime.make(
  Layer.scoped(ApiClient, makeClient).pipe(Layer.provide(ProtocolLive)),
)

const call = <A, E>(f: (client: Client) => Effect.Effect<A, E>): Promise<A> =>
  runtime.runPromise(Effect.flatMap(ApiClient, f))

type Fields = Record<string, unknown>

export interface GoogleStatus {
  /** Server-side OAuth credentials present — false means the integration is disabled. */
  readonly configured: boolean
  readonly connected: boolean
  readonly email?: string | null
  readonly scopes?: ReadonlyArray<string>
  readonly lastSyncAt?: string | null
  readonly lastError?: string | null
  readonly calendarWatchExpiresAt?: string | null
  readonly gmailWatchExpiresAt?: string | null
}

export interface GoogleCalendarEvent {
  readonly id: string
  readonly summary: string | null
  readonly description: string | null
  readonly location: string | null
  readonly start_at: string | null
  readonly end_at: string | null
  readonly all_day: boolean
  readonly attendees: unknown
  readonly html_link: string | null
  readonly status: string | null
}

export interface GoogleThread {
  readonly id: string
  readonly subject: string | null
  readonly snippet: string | null
  readonly from_email: string | null
  readonly last_message_at: string | null
  readonly label_ids: ReadonlyArray<string>
}

export interface GoogleMessage {
  readonly id: string
  readonly subject: string | null
  readonly from_email: string | null
  readonly to_email: string | null
  readonly sent_at: string | null
  readonly snippet: string | null
  readonly body_text: string | null
  readonly body_html: string | null
  readonly label_ids: ReadonlyArray<string>
}

export type PosthogRegion = "us" | "eu" | "custom"

export interface PosthogStatus {
  /** PostHog is key-based (no server OAuth creds), so this is always true. */
  readonly configured: boolean
  readonly connected: boolean
  readonly host?: string
  readonly region?: PosthogRegion
  readonly projectId?: string
  readonly projectName?: string | null
  readonly lastSyncAt?: string | null
  readonly lastError?: string | null
  readonly webhookUrl?: string | null
}

export interface PosthogConnectInput {
  readonly apiKey: string
  readonly region: PosthogRegion
  /** Required when region is "custom" (a self-hosted https origin). */
  readonly host?: string
  /** Optional — if omitted the first accessible project is bound. */
  readonly projectId?: string
}

export interface PosthogPerson {
  readonly distinct_id: string
  readonly person_id: string | null
  readonly email: string | null
  readonly name: string | null
  readonly event_count: number
  readonly first_seen_at: string | null
  readonly last_seen_at: string | null
  readonly synced_at: string | null
}

export interface LinearStatus {
  /** Linear is key-based (no server OAuth creds), so this is always true. */
  readonly configured: boolean
  readonly connected: boolean
  readonly viewerId?: string | null
  readonly viewerName?: string | null
  readonly lastSyncAt?: string | null
  readonly lastError?: string | null
  readonly webhookUrl?: string | null
  /** Whether a webhook signing secret is stored (required to accept webhooks). */
  readonly webhookConfigured?: boolean
}

export interface LinearConnectInput {
  readonly apiKey: string
  /** Optional Linear webhook signing secret (enables the inbound receiver). */
  readonly webhookSecret?: string
}

export interface LinearIssue {
  readonly linear_id: string
  readonly identifier: string | null
  readonly title: string | null
  readonly state: string | null
  readonly state_type: string | null
  readonly assignee_name: string | null
  readonly team_key: string | null
  readonly priority: number | null
  readonly url: string | null
  readonly updated_at: string | null
  readonly synced_at: string | null
}

export interface SlackStatus {
  /** Slack is OAuth-based: reflects SLACK_CLIENT_ID/SECRET + SIGNING_SECRET env. */
  readonly configured: boolean
  readonly connected: boolean
  readonly teamId?: string
  readonly teamName?: string | null
  readonly botUserId?: string | null
  readonly scopes?: ReadonlyArray<string>
  readonly lastSyncAt?: string | null
  readonly lastError?: string | null
  /** Inbound URLs to paste into the Slack app config (events/slash/interactivity). */
  readonly eventsUrl?: string | null
  readonly commandsUrl?: string | null
  readonly interactivityUrl?: string | null
  /** The current user's per-user (xoxp) token state — layered on the org bot. */
  readonly user?: {
    readonly connected: boolean
    readonly slackUserId?: string | null
    readonly slackUserName?: string | null
    readonly scopes?: ReadonlyArray<string>
  }
}

export interface SlackChannel {
  readonly channelId: string
  readonly name: string | null
  readonly isPrivate: boolean
  readonly isArchived: boolean
}

export interface ApolloEnrichmentField {
  readonly key: string
  readonly label: string
}

export interface ApolloStatus {
  /** Apollo is key-based (no server OAuth creds), so this is always true. */
  readonly configured: boolean
  readonly connected: boolean
  readonly lastValidatedAt?: string | null
  readonly lastError?: string | null
  /** Catalog of Apollo enrichment keys the operator can map to KM field ids. */
  readonly enrichmentFields?: ReadonlyArray<ApolloEnrichmentField>
}

/** A normalized Apollo person — a flat map of enrichment key → value. */
export type ApolloPerson = Readonly<Record<string, string | number | null>>

export interface ApolloEnrichResult {
  readonly ok: boolean
  readonly matched: boolean
  readonly updated: boolean
  readonly cached?: boolean
  readonly fields: ReadonlyArray<string>
  readonly enrichment?: ApolloPerson
}

export interface ApolloSearchResult {
  readonly people: ReadonlyArray<ApolloPerson>
  readonly pagination: {
    page?: number
    perPage?: number
    totalEntries?: number
    totalPages?: number
  } | null
}

export interface ApolloImportResult {
  readonly ok: boolean
  readonly created: ReadonlyArray<string>
  readonly skipped: number
  readonly errors: ReadonlyArray<{ index: number; code: string }>
}

export interface ClayStatus {
  /** Clay is webhook/key-based (no server OAuth creds), so this is always true. */
  readonly configured: boolean
  readonly connected: boolean
  /** Callback URL (incl. routing id + secret token) to paste into Clay. */
  readonly callbackUrl?: string
  readonly hasTableWebhook?: boolean
  readonly hasApiKey?: boolean
  readonly newRowConceptId?: string | null
  readonly newRowAutoCreate?: boolean
  readonly lastValidatedAt?: string | null
  readonly lastError?: string | null
}

/** Result of pushing an instance into Clay (async — enriched data returns later). */
export interface ClayEnrichResult {
  readonly ok: boolean
  /** Correlation id KM embeds in the row and Clay echoes on callback. */
  readonly jobId: string
}

/** Typed, end-to-end client — replaces the old hand-written fetch wrappers. */
export const api = {
  listConcepts: (opts?: { includeArchived?: boolean; withCounts?: boolean }) =>
    call((c) =>
      c.listConcepts({ includeArchived: opts?.includeArchived, withCounts: opts?.withCounts }),
    ),
  createConcept: (name: string, color?: string | null) =>
    call((c) => c.createConcept({ name, color })),
  updateConcept: (
    id: string,
    patch: {
      name?: string
      pluralName?: string | null
      description: string | null
      icon?: string | null
      color?: string | null
      versioningEnabled?: boolean
      staticLabelIds?: ReadonlyArray<string>
      defaultLabelIds?: ReadonlyArray<string>
    },
  ) =>
    call((c) =>
      c.updateConcept({
        id,
        name: patch.name,
        pluralName: patch.pluralName,
        description: patch.description,
        icon: patch.icon,
        color: patch.color,
        versioningEnabled: patch.versioningEnabled,
        staticLabelIds: patch.staticLabelIds,
        defaultLabelIds: patch.defaultLabelIds,
      }),
    ),
  setConceptInstanceView: (id: string, instanceView: InstanceViewLayout | null) =>
    call((c) => c.setConceptInstanceView({ id, instanceView })),
  setConceptTitleField: (id: string, titleFieldId: string | null) =>
    call((c) => c.setConceptTitleField({ id, titleFieldId })),
  archiveConcept: (id: string) => call((c) => c.archiveConcept({ id })),
  restoreConcept: (id: string) => call((c) => c.restoreConcept({ id })),
  deleteConcept: (id: string) => call((c) => c.deleteConcept({ id })),
  listLabels: (opts?: { includeArchived?: boolean }) =>
    call((c) => c.listLabels({ includeArchived: opts?.includeArchived })),
  createLabel: (name: string, color?: string | null, primary?: boolean) =>
    call((c) => c.createLabel({ name, color, primary })),
  renameLabel: (id: string, patch: { name?: string; color?: string | null; primary?: boolean }) =>
    call((c) =>
      c.renameLabel({ id, name: patch.name, color: patch.color, primary: patch.primary }),
    ),
  archiveLabel: (id: string) => call((c) => c.archiveLabel({ id })),
  restoreLabel: (id: string) => call((c) => c.restoreLabel({ id })),
  deleteLabel: (id: string) => call((c) => c.deleteLabel({ id })),
  listFields: (conceptId: string, opts?: { includeArchived?: boolean }) =>
    call((c) => c.listFields({ conceptId, includeArchived: opts?.includeArchived })),
  getConceptGraph: () => call((c) => c.getConceptGraph()),
  getGraphLayout: () => call((c) => c.getGraphLayout()),
  saveGraphLayout: (positions: GraphLayout) => call((c) => c.saveGraphLayout({ positions })),
  getInstanceGraphLayout: (itemId: string) => call((c) => c.getInstanceGraphLayout({ itemId })),
  saveInstanceGraphLayout: (itemId: string, positions: GraphLayout) =>
    call((c) => c.saveInstanceGraphLayout({ itemId, positions })),
  addField: (input: {
    conceptId: string
    name: string
    kind: FieldKind
    config?: FieldConfig
    formula?: string
    icon?: string | null
  }) => call((c) => c.addField(input)),
  updateField: (input: {
    id: string
    name?: string
    config?: FieldConfig
    formula?: string | null
    icon?: string | null
  }) => call((c) => c.updateField(input)),
  archiveField: (id: string) => call((c) => c.archiveField({ id })),
  restoreField: (id: string) => call((c) => c.restoreField({ id })),
  deleteField: (id: string) => call((c) => c.deleteField({ id })),
  reorderFields: (conceptId: string, orders: ReadonlyArray<{ id: string; position: number }>) =>
    call((c) => c.reorderFields({ conceptId, orders })),
  listInstances: (conceptId: string, opts?: { includeArchived?: boolean }) =>
    call((c) => c.listInstances({ conceptId, includeArchived: opts?.includeArchived })),
  getInstance: (id: string) => call((c) => c.getInstance({ id })),
  getChanged: () => call((c) => c.getChanged()),
  listEvents: (input?: { conceptId?: string | null; since?: number; limit?: number }) =>
    call((c) =>
      c.listEvents({ conceptId: input?.conceptId, since: input?.since, limit: input?.limit }),
    ),
  createInstance: (conceptId: string, fields: Fields) =>
    call((c) => c.createInstance({ conceptId, fields })),
  updateInstance: (id: string, expectedVersion: number, patch: Fields) =>
    call((c) => c.updateInstance({ id, expectedVersion, patch })),
  transitionInstance: (id: string, expectedVersion: number, field: string, to: string) =>
    call((c) => c.transitionInstance({ id, expectedVersion, field, to })),
  archiveInstance: (id: string, expectedVersion: number) =>
    call((c) => c.archiveInstance({ id, expectedVersion })),
  restoreInstance: (id: string, expectedVersion: number) =>
    call((c) => c.restoreInstance({ id, expectedVersion })),
  deleteInstance: (id: string) => call((c) => c.deleteInstance({ id })),
  // ── versioning ──────────────────────────────────────────────────────────────
  listVersions: (itemId: string) => call((c) => c.listVersions({ itemId })),
  newVersion: (itemId: string) => call((c) => c.newVersion({ itemId })),
  publishVersion: (id: string, expectedVersion: number) =>
    call((c) => c.publishVersion({ id, expectedVersion })),
  discardDraft: (id: string) => call((c) => c.discardDraft({ id })),
  archiveItem: (itemId: string) => call((c) => c.archiveItem({ itemId })),
  restoreItem: (itemId: string) => call((c) => c.restoreItem({ itemId })),
  searchInstances: (conceptId: string, query?: string, limit?: number) =>
    call((c) => c.searchInstances({ conceptId, query, limit })),
  createRelation: (input: {
    fieldId: string
    fromId: string
    toItemId?: string
    toVersionId?: string
    toId?: string
    properties?: Fields
  }) => call((c) => c.createRelation(input)),
  removeRelation: (relationId: string) => call((c) => c.removeRelation({ relationId })),
  listViews: () => call((c) => c.listViews()),
  createView: (input: {
    name: string
    icon?: string | null
    scope: "personal" | "org"
    body: SidebarViewBody
  }) => call((c) => c.createView(input)),
  updateView: (input: {
    id: string
    name?: string
    icon?: string | null
    hidden?: boolean
    scope?: "personal" | "org"
    body?: SidebarViewBody
  }) => call((c) => c.updateView(input)),
  deleteView: (id: string) => call((c) => c.deleteView({ id })),
  reorderViews: (orders: ReadonlyArray<{ id: string; position: number }>) =>
    call((c) => c.reorderViews({ orders })),
  listDashboards: () => call((c) => c.listDashboards()),
  createDashboard: (input: {
    name: string
    icon?: string | null
    scope: "personal" | "org"
    body: DashboardBody
  }) => call((c) => c.createDashboard(input)),
  updateDashboard: (input: {
    id: string
    name?: string
    icon?: string | null
    hidden?: boolean
    scope?: "personal" | "org"
    body?: DashboardBody
    expectedUpdatedAt?: Date
  }) => call((c) => c.updateDashboard(input)),
  deleteDashboard: (id: string) => call((c) => c.deleteDashboard({ id })),
  reorderDashboards: (orders: ReadonlyArray<{ id: string; position: number }>) =>
    call((c) => c.reorderDashboards({ orders })),
  // ── annotation layer: notes ───────────────────────────────────────────────────
  listNotes: (subjectId: string, opts?: { includeArchived?: boolean }) =>
    call((c) => c.listNotes({ subjectId, includeArchived: opts?.includeArchived })),
  createNote: (subjectId: string | null, body: string, customFields?: Fields) =>
    call((c) => c.createNote({ subjectId, body, customFields })),
  updateNote: (
    id: string,
    expectedVersion: number,
    patch: { body?: string; customFields?: Fields },
  ) => call((c) => c.updateNote({ id, expectedVersion, ...patch })),
  archiveNote: (id: string, expectedVersion: number) =>
    call((c) => c.archiveNote({ id, expectedVersion })),
  restoreNote: (id: string, expectedVersion: number) =>
    call((c) => c.restoreNote({ id, expectedVersion })),
  deleteNote: (id: string) => call((c) => c.deleteNote({ id })),
  // ── annotation layer: tasks ───────────────────────────────────────────────────
  listTasks: (filter?: {
    subjectId?: string | null
    assignee?: string
    statusId?: string
    dueBefore?: string
    dueAfter?: string
    includeArchived?: boolean
    limit?: number
  }) => call((c) => c.listTasks(filter ?? {})),
  resolveTaskSubjects: (subjectIds: ReadonlyArray<string>) =>
    call((c) => c.resolveTaskSubjects({ subjectIds })),
  createTask: (input: {
    subjectId: string | null
    title: string
    description?: RichTextEnvelope | null
    statusId?: string | null
    priorityId?: string | null
    labelIds?: ReadonlyArray<string>
    assignee?: string | null
    dueAt?: string | null
    customFields?: Fields
  }) => call((c) => c.createTask(input)),
  updateTask: (
    id: string,
    expectedVersion: number,
    patch: {
      title?: string
      description?: RichTextEnvelope | null
      priorityId?: string | null
      labelIds?: ReadonlyArray<string>
      dueAt?: string | null
      customFields?: Fields
    },
  ) => call((c) => c.updateTask({ id, expectedVersion, ...patch })),
  setTaskStatus: (id: string, expectedVersion: number, statusId: string) =>
    call((c) => c.setTaskStatus({ id, expectedVersion, statusId })),
  assignTask: (id: string, expectedVersion: number, assignee: string | null) =>
    call((c) => c.assignTask({ id, expectedVersion, assignee })),
  snoozeTask: (id: string, expectedVersion: number, until: string | null) =>
    call((c) => c.snoozeTask({ id, expectedVersion, until })),
  setTaskBlocked: (
    id: string,
    expectedVersion: number,
    blocked: null | { reason?: string | null; taskId?: string | null },
  ) => call((c) => c.setTaskBlocked({ id, expectedVersion, blocked })),
  archiveTask: (id: string, expectedVersion: number) =>
    call((c) => c.archiveTask({ id, expectedVersion })),
  restoreTask: (id: string, expectedVersion: number) =>
    call((c) => c.restoreTask({ id, expectedVersion })),
  deleteTask: (id: string) => call((c) => c.deleteTask({ id })),
  getActivity: (subjectId: string, limit?: number) =>
    call((c) => c.getActivity({ subjectId, limit })),
  // ── annotation layer: files ───────────────────────────────────────────────────
  // Metadata via typed RPCs; the bytes ride plain HTTP (multipart up, binary
  // down — `uploadFile` / the URL helpers below).
  listFiles: (filter?: {
    itemId?: string
    instanceId?: string
    conceptId?: string
    includeArchived?: boolean
    limit?: number
  }) => call((c) => c.listFiles(filter ?? {})),
  archiveFile: (id: string) => call((c) => c.archiveFile({ id })),
  restoreFile: (id: string) => call((c) => c.restoreFile({ id })),
  deleteFile: (id: string) => call((c) => c.deleteFile({ id })),
  /** Multipart upload onto an item lineage. Callers refetch their list — the
   *  raw JSON body isn't schema-decoded like RPC results, so don't return it. */
  uploadFile: async (itemId: string, file: File): Promise<void> => {
    const form = new FormData()
    form.append("file", file)
    const res = await fetch(`/api/items/${itemId}/attachments`, { method: "POST", body: form })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ? `Upload failed: ${body.error}` : "Upload failed")
    }
  },
  /** Browser-native save (content-disposition: attachment). */
  fileDownloadUrl: (id: string) => `/api/attachments/${id}/download`,
  /** Inline render (img/pdf preview) — same bytes, inline disposition. */
  fileInlineUrl: (id: string) => `/api/attachments/${id}/download?inline=1`,
  // ── Google integration ──────────────────────────────────────────────────────
  getGoogleStatus: async (): Promise<GoogleStatus> => {
    const res = await fetch("/api/integrations/google/status")
    if (!res.ok) throw new Error("Failed to load Google status")
    return (await res.json()) as GoogleStatus
  },
  disconnectGoogle: async (): Promise<void> => {
    const res = await fetch("/api/integrations/google/disconnect", { method: "POST" })
    if (!res.ok) throw new Error("Failed to disconnect Google")
  },
  syncGoogle: async (): Promise<void> => {
    const res = await fetch("/api/integrations/google/sync", { method: "POST" })
    if (!res.ok) throw new Error("Failed to sync Google")
  },
  listGoogleCalendarEvents: async (): Promise<ReadonlyArray<GoogleCalendarEvent>> => {
    const res = await fetch("/api/integrations/google/calendar")
    if (!res.ok) throw new Error("Failed to load Google Calendar")
    const body = (await res.json()) as { events: ReadonlyArray<GoogleCalendarEvent> }
    return body.events
  },
  listGoogleThreads: async (): Promise<ReadonlyArray<GoogleThread>> => {
    const res = await fetch("/api/integrations/google/gmail/threads")
    if (!res.ok) throw new Error("Failed to load Gmail threads")
    const body = (await res.json()) as { threads: ReadonlyArray<GoogleThread> }
    return body.threads
  },
  getGoogleThread: async (threadId: string): Promise<ReadonlyArray<GoogleMessage>> => {
    const res = await fetch(
      `/api/integrations/google/gmail/threads/${encodeURIComponent(threadId)}`,
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (body?.error === "GMAIL_READ_SCOPE_REQUIRED") throw new Error("GMAIL_READ_SCOPE_REQUIRED")
      throw new Error("Failed to load Gmail thread")
    }
    const body = (await res.json()) as { messages: ReadonlyArray<GoogleMessage> }
    return body.messages
  },
  sendGoogleMessage: async (input: {
    to: string
    subject: string
    text: string
    threadId?: string
  }): Promise<{ id: string; threadId: string | null }> => {
    const res = await fetch("/api/integrations/google/gmail/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (body?.error === "GMAIL_SEND_SCOPE_REQUIRED") throw new Error("GMAIL_SEND_SCOPE_REQUIRED")
      throw new Error("Failed to send Gmail message")
    }
    return (await res.json()) as { id: string; threadId: string | null }
  },
  // ── PostHog integration ──────────────────────────────────────────────────────
  getPosthogStatus: async (): Promise<PosthogStatus> => {
    const res = await fetch("/api/integrations/posthog/status")
    if (!res.ok) throw new Error("Failed to load PostHog status")
    return (await res.json()) as PosthogStatus
  },
  connectPosthog: async (input: PosthogConnectInput): Promise<PosthogStatus> => {
    const res = await fetch("/api/integrations/posthog/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to connect PostHog")
    }
    return (await res.json()) as PosthogStatus
  },
  disconnectPosthog: async (): Promise<void> => {
    const res = await fetch("/api/integrations/posthog/disconnect", { method: "POST" })
    if (!res.ok) throw new Error("Failed to disconnect PostHog")
  },
  syncPosthog: async (): Promise<void> => {
    const res = await fetch("/api/integrations/posthog/sync", { method: "POST" })
    if (!res.ok) throw new Error("Failed to sync PostHog")
  },
  listPosthogPersons: async (): Promise<ReadonlyArray<PosthogPerson>> => {
    const res = await fetch("/api/integrations/posthog/persons")
    if (!res.ok) throw new Error("Failed to load PostHog persons")
    const body = (await res.json()) as { persons: ReadonlyArray<PosthogPerson> }
    return body.persons
  },
  // ── Linear integration ─────────────────────────────────────────────────────────
  getLinearStatus: async (): Promise<LinearStatus> => {
    const res = await fetch("/api/integrations/linear/status")
    if (!res.ok) throw new Error("Failed to load Linear status")
    return (await res.json()) as LinearStatus
  },
  connectLinear: async (input: LinearConnectInput): Promise<LinearStatus> => {
    const res = await fetch("/api/integrations/linear/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to connect Linear")
    }
    return (await res.json()) as LinearStatus
  },
  disconnectLinear: async (): Promise<void> => {
    const res = await fetch("/api/integrations/linear/disconnect", { method: "POST" })
    if (!res.ok) throw new Error("Failed to disconnect Linear")
  },
  syncLinear: async (): Promise<void> => {
    const res = await fetch("/api/integrations/linear/sync", { method: "POST" })
    if (!res.ok) throw new Error("Failed to sync Linear")
  },
  listLinearIssues: async (): Promise<ReadonlyArray<LinearIssue>> => {
    const res = await fetch("/api/integrations/linear/issues")
    if (!res.ok) throw new Error("Failed to load Linear issues")
    const body = (await res.json()) as { issues: ReadonlyArray<LinearIssue> }
    return body.issues
  },
  updateLinearIssue: async (
    issueId: string,
    input: Record<string, unknown>,
  ): Promise<{ issue: LinearIssue | null }> => {
    const res = await fetch(`/api/integrations/linear/issues/${encodeURIComponent(issueId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to update Linear issue")
    }
    return (await res.json()) as { issue: LinearIssue | null }
  },
  closeLinearIssue: async (issueId: string): Promise<{ issue: LinearIssue | null }> => {
    const res = await fetch(
      `/api/integrations/linear/issues/${encodeURIComponent(issueId)}/close`,
      { method: "POST" },
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to close Linear issue")
    }
    return (await res.json()) as { issue: LinearIssue | null }
  },
  // ── Slack integration ────────────────────────────────────────────────────────
  getSlackStatus: async (): Promise<SlackStatus> => {
    const res = await fetch("/api/integrations/slack/status")
    if (!res.ok) throw new Error("Failed to load Slack status")
    return (await res.json()) as SlackStatus
  },
  disconnectSlack: async (): Promise<void> => {
    const res = await fetch("/api/integrations/slack/disconnect", { method: "POST" })
    if (!res.ok) throw new Error("Failed to disconnect Slack")
  },
  disconnectSlackUser: async (): Promise<void> => {
    const res = await fetch("/api/integrations/slack/user/disconnect", { method: "POST" })
    if (!res.ok) throw new Error("Failed to disconnect Slack account")
  },
  syncSlack: async (): Promise<void> => {
    const res = await fetch("/api/integrations/slack/sync", { method: "POST" })
    if (!res.ok) throw new Error("Failed to sync Slack")
  },
  listSlackChannels: async (): Promise<ReadonlyArray<SlackChannel>> => {
    const res = await fetch("/api/integrations/slack/channels")
    if (!res.ok) throw new Error("Failed to load Slack channels")
    const body = (await res.json()) as { channels: ReadonlyArray<SlackChannel> }
    return body.channels
  },
  postSlackMessage: async (input: {
    channel: string
    text?: string
    blocks?: unknown[]
    threadTs?: string
  }): Promise<{ ok: boolean; ts: string | null; channel: string }> => {
    const res = await fetch("/api/integrations/slack/post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to post Slack message")
    }
    return (await res.json()) as { ok: boolean; ts: string | null; channel: string }
  },
  /** Post a message AS the current user (xoxp token), not the bot. */
  postSlackMessageAsMe: async (input: {
    channel: string
    text?: string
    blocks?: unknown[]
    threadTs?: string
  }): Promise<{ ok: boolean; ts: string | null; channel: string }> => {
    const res = await fetch("/api/integrations/slack/post-as-me", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to post Slack message")
    }
    return (await res.json()) as { ok: boolean; ts: string | null; channel: string }
  },
  // ── Apollo integration ─────────────────────────────────────────────────────────
  getApolloStatus: async (): Promise<ApolloStatus> => {
    const res = await fetch("/api/integrations/apollo/status")
    if (!res.ok) throw new Error("Failed to load Apollo status")
    return (await res.json()) as ApolloStatus
  },
  connectApollo: async (apiKey: string): Promise<ApolloStatus> => {
    const res = await fetch("/api/integrations/apollo/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to connect Apollo")
    }
    return (await res.json()) as ApolloStatus
  },
  disconnectApollo: async (): Promise<void> => {
    const res = await fetch("/api/integrations/apollo/disconnect", { method: "POST" })
    if (!res.ok) throw new Error("Failed to disconnect Apollo")
  },
  /** Enrich an instance's fields from Apollo via an {apolloKey → fieldId} mapping. */
  enrichApolloInstance: async (input: {
    instanceId: string
    mapping: Record<string, string>
    query?: Record<string, string>
    overwrite?: boolean
  }): Promise<ApolloEnrichResult> => {
    const res = await fetch("/api/integrations/apollo/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to enrich with Apollo")
    }
    return (await res.json()) as ApolloEnrichResult
  },
  searchApollo: async (params: {
    q?: string
    titles?: string[]
    domains?: string[]
    locations?: string[]
    page?: number
    perPage?: number
  }): Promise<ApolloSearchResult> => {
    const res = await fetch("/api/integrations/apollo/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to search Apollo")
    }
    return (await res.json()) as ApolloSearchResult
  },
  /** Bulk-import search results as new instances onto a concept via a mapping. */
  importApollo: async (input: {
    conceptId: string
    mapping: Record<string, string>
    people: ReadonlyArray<ApolloPerson>
  }): Promise<ApolloImportResult> => {
    const res = await fetch("/api/integrations/apollo/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to import Apollo results")
    }
    return (await res.json()) as ApolloImportResult
  },
  // ── Clay integration ────────────────────────────────────────────────────────────
  getClayStatus: async (): Promise<ClayStatus> => {
    const res = await fetch("/api/integrations/clay/status")
    if (!res.ok) throw new Error("Failed to load Clay status")
    return (await res.json()) as ClayStatus
  },
  connectClay: async (input: {
    tableWebhookUrl: string
    apiKey?: string
    newRowConceptId?: string
    newRowMapping?: Record<string, string>
  }): Promise<ClayStatus> => {
    const res = await fetch("/api/integrations/clay/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to connect Clay")
    }
    return (await res.json()) as ClayStatus
  },
  disconnectClay: async (): Promise<void> => {
    const res = await fetch("/api/integrations/clay/disconnect", { method: "POST" })
    if (!res.ok) throw new Error("Failed to disconnect Clay")
  },
  /**
   * Push an instance into the Clay table via a {clayColumn → fieldId} mapping.
   * Async: enriched data returns later through the Clay callback. (The Details-tile
   * "Send to Clay" button + mapping picker is a deferred follow-up.)
   */
  sendInstanceToClay: async (input: {
    instanceId: string
    mapping: Record<string, string>
    extra?: Record<string, unknown>
  }): Promise<ClayEnrichResult> => {
    const res = await fetch("/api/integrations/clay/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? "Failed to send to Clay")
    }
    return (await res.json()) as ClayEnrichResult
  },
  // ── annotation layer: task statuses (admin) ───────────────────────────────────
  listTaskStatuses: (opts?: { includeArchived?: boolean }) =>
    call((c) => c.listTaskStatuses({ includeArchived: opts?.includeArchived })),
  createTaskStatus: (input: {
    name: string
    category: TaskStatusCategory
    color?: string | null
    isDefault?: boolean
  }) => call((c) => c.createTaskStatus(input)),
  updateTaskStatus: (input: {
    id: string
    name?: string
    color?: string | null
    category?: TaskStatusCategory
    isDefault?: boolean
  }) => call((c) => c.updateTaskStatus(input)),
  archiveTaskStatus: (id: string) => call((c) => c.archiveTaskStatus({ id })),
  restoreTaskStatus: (id: string) => call((c) => c.restoreTaskStatus({ id })),
  reorderTaskStatuses: (orders: ReadonlyArray<{ id: string; position: number }>) =>
    call((c) => c.reorderTaskStatuses({ orders })),
  // ── annotation layer: task priorities (admin) ─────────────────────────────────
  listTaskPriorities: (opts?: { includeArchived?: boolean }) =>
    call((c) => c.listTaskPriorities({ includeArchived: opts?.includeArchived })),
  createTaskPriority: (input: { name: string; color?: string | null }) =>
    call((c) => c.createTaskPriority(input)),
  updateTaskPriority: (input: { id: string; name?: string; color?: string | null }) =>
    call((c) => c.updateTaskPriority(input)),
  archiveTaskPriority: (id: string) => call((c) => c.archiveTaskPriority({ id })),
  restoreTaskPriority: (id: string) => call((c) => c.restoreTaskPriority({ id })),
  reorderTaskPriorities: (orders: ReadonlyArray<{ id: string; position: number }>) =>
    call((c) => c.reorderTaskPriorities({ orders })),
  // ── annotation layer: custom-field definitions (admin) ─────────────────────────
  listAnnotationFields: (annotationType: "note" | "task", opts?: { includeArchived?: boolean }) =>
    call((c) => c.listAnnotationFields({ annotationType, includeArchived: opts?.includeArchived })),
  addAnnotationField: (input: {
    annotationType: "note" | "task"
    name: string
    kind: FieldKind
    config?: FieldConfig
    icon?: string | null
  }) => call((c) => c.addAnnotationField(input)),
  updateAnnotationField: (input: {
    id: string
    name?: string
    config?: FieldConfig
    icon?: string | null
  }) => call((c) => c.updateAnnotationField(input)),
  archiveAnnotationField: (id: string) => call((c) => c.archiveAnnotationField({ id })),
  restoreAnnotationField: (id: string) => call((c) => c.restoreAnnotationField({ id })),
  reorderAnnotationFields: (
    annotationType: "note" | "task",
    orders: ReadonlyArray<{ id: string; position: number }>,
  ) => call((c) => c.reorderAnnotationFields({ annotationType, orders })),
  // Member deactivation; member purge is a plain-HTTP DELETE (see Members
  // directory page).
  // Instance-view layout prefs — always the caller's own row.
  getInstanceViewPrefs: () => call((c) => c.getInstanceViewPrefs()),
  updateInstanceViewPrefs: (body: InstanceViewPrefsBody) =>
    call((c) => c.updateInstanceViewPrefs({ body })),
  listDeactivatedMembers: () => call((c) => c.listDeactivatedMembers()),
  deactivateMember: (userId: string) => call((c) => c.deactivateMember({ userId })),
  reactivateMember: (userId: string) => call((c) => c.reactivateMember({ userId })),
}
