import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import {
  type AccessActionName,
  type AccessCondition,
  type AccessResourceType,
  type AutomationAction,
  type AutomationTrigger,
  type DashboardBody,
  type EditReach,
  type FieldConfig,
  type FieldKind,
  type GraphLayout,
  KingsmakerRpcs,
  type MentionTarget,
  type RecordViewLayout,
  type RecordViewPrefsBody,
  type RichTextEnvelope,
  type SidebarCondition,
  type SidebarViewBody,
  type TaskStatusCategory,
} from "../../rpc/contract"

export type {
  AccessActionName,
  AccessCondition,
  AccessGrant,
  AccessResourceType,
  AccessRole,
  AccessRule,
  AnnotationField,
  AnnotationType,
  Attachment,
  Automation,
  AutomationAction,
  AutomationDryRun,
  AutomationRun,
  AutomationTrigger,
  BacklinkRef,
  Concept,
  ConceptGraph,
  ConceptGraphEdge,
  ConceptGraphNode,
  Dashboard,
  DashboardBody,
  DashboardGroup,
  DashboardNode,
  DashboardWidget,
  DeactivatedMember,
  EditReach,
  EffectiveAccess,
  FeedItem,
  Field,
  FieldConfig,
  FieldKind,
  GraphLayout,
  KmRecord,
  Label,
  MentionKind,
  MentionRef,
  MentionTarget,
  Note,
  RecordDetail,
  RecordPick,
  RecordVersion,
  RecordViewLayout,
  RecordViewPrefs,
  RecordViewPrefsBody,
  RecordViewTile,
  RelatedRecord,
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

/** Who a new upload belongs to: a record, or a Files widget's own bucket
 *  (`shared: false` hides it from org-scope widgets). Mirrors the engine's
 *  `UploadOwner` — the two upload routes take exactly one of these. */
export type FileOwner =
  | { readonly recordId: string }
  | { readonly bucketId: string; readonly shared?: boolean }

/** The server's cap, in MB, for the one message the user can act on. Kept in sync
 *  with `MAX_UPLOAD_BYTES` (the engine can't be imported into the browser bundle). */
export const MAX_UPLOAD_MB = 25

/** Computed-field shapes (carried inside a record version's `state`). */
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

/** What build is running, and is a newer one published. See server/version.ts. */
export interface VersionInfo {
  readonly current: string
  readonly latest: string | null
  readonly updateAvailable: boolean
  readonly checkedAt: string | null
  readonly checkDisabled: boolean
}

/** Which sign-in methods the active org accepts. Never both false. */
export interface AuthMethods {
  readonly passwordEnabled: boolean
  readonly ssoEnabled: boolean
}

export interface SsoProvider {
  readonly providerId: string
  readonly issuer: string
  readonly domain: string
  readonly clientId: string
  /** A secret is stored. The value itself is never sent to the client. */
  readonly hasSecret: boolean
}

export interface SsoProviderInput {
  readonly issuer: string
  readonly domain: string
  readonly clientId: string
  readonly clientSecret: string
}

export interface AuthConfig {
  readonly methods: AuthMethods
  readonly provider: SsoProvider | null
  /** Redirect URI to register at the IdP — server-computed, never guessed. */
  readonly callbackUrl: string
  /** The caller is the org owner. Admins get this read-only. */
  readonly canEdit: boolean
}

/**
 * Server error codes → something an operator can act on. The handlers return
 * bare codes (see server/sso.ts); anything unmapped falls through to the code
 * itself rather than a generic message, so an unexpected one is still legible.
 */
const AUTH_CONFIG_ERRORS: Record<string, string> = {
  FORBIDDEN: "Only the organization owner can change authentication settings.",
  MISSING_FIELDS: "Fill in every field.",
  INVALID_ISSUER: "The issuer must be a valid URL.",
  ISSUER_MUST_BE_HTTPS: "The issuer must use https.",
  INVALID_DOMAIN: "Enter bare domains (e.g. acme.com), not emails or URLs.",
  NO_SIGN_IN_METHOD: "At least one sign-in method must stay enabled.",
  NO_SSO_PROVIDER: "Configure an identity provider before enabling SSO.",
  REGISTER_FAILED: "The identity provider could not be reached.",
}

const authConfigError = (code?: string, message?: string): string => {
  const base = AUTH_CONFIG_ERRORS[code ?? ""] ?? code ?? "Request failed"
  return message ? `${base} (${message})` : base
}

/**
 * The per-org integration toggles. `effective` is what the server will actually
 * do; `overrides` is null wherever this org inherits, and `defaults` is what it
 * would inherit — the UI needs all three to render "Server default: on" next to
 * a control the org hasn't overridden.
 */
export interface IntegrationSettings {
  readonly googleSyncEnabled: boolean
  readonly googleWatchEnabled: boolean
  readonly slackSyncEnabled: boolean
  readonly posthogSyncEnabled: boolean
  readonly linearSyncEnabled: boolean
  readonly apolloEnrichCacheEnabled: boolean
  readonly apolloEnrichCacheTtlDays: number
  readonly analyticsCacheTtlMs: number
}
export type IntegrationOverrides = {
  readonly [K in keyof IntegrationSettings]: IntegrationSettings[K] | null
}
export type IntegrationSettingsPatch = {
  readonly [K in keyof IntegrationSettings]?: IntegrationSettings[K] | null
}
export interface IntegrationSettingsPayload {
  readonly effective: IntegrationSettings
  readonly overrides: IntegrationOverrides
  readonly defaults: IntegrationSettings
  readonly canEdit: boolean
}

/** A sync route refused because the org turned that connector's sync off. */
const syncError = async (res: Response, name: string): Promise<Error> => {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return new Error(
    body?.error === "SYNC_DISABLED"
      ? `${name} sync is turned off for this organization.`
      : `Failed to sync ${name}`,
  )
}

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
  /** Send as the `webhookTokenHeader` header; admin-only, null for members. */
  readonly webhookToken?: string | null
  readonly webhookTokenHeader?: string
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

/** Analytics query — the `analytics` widget's config, with any record-derived
 *  filter already resolved to a concrete value by the caller. `metric: "custom"`
 *  sends `query` (raw provider query) instead of the structured knobs. */
export interface AnalyticsQueryInput {
  readonly provider?: "posthog"
  readonly metric: "active_users" | "event_count" | "custom"
  readonly interval: "day" | "week" | "month"
  readonly since: "7d" | "30d" | "90d"
  readonly query?: string | null
  readonly event?: string | null
  readonly breakdown?: string | null
  readonly recordProperty?: string | null
  readonly recordValue?: string | null
  readonly includePrior?: boolean
}

/** An analytics failure the widget renders inline. `message` is the server's
 *  error CODE; `detail` is the human part (a HogQL parse error, the columns a
 *  custom query actually returned) — the only debugging aid the author has. */
export class AnalyticsQueryError extends Error {
  constructor(
    code: string,
    readonly detail: string | null,
  ) {
    super(code)
    this.name = "AnalyticsQueryError"
  }
}

export interface AnalyticsSeries {
  readonly name: string
  readonly points: ReadonlyArray<{ readonly t: string; readonly value: number }>
}

export interface AnalyticsResult {
  readonly series: ReadonlyArray<AnalyticsSeries>
  readonly delta: { readonly cur: number; readonly prior: number } | null
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
  /** Send as the `webhookTokenHeader` header; admin-only, null for members. */
  readonly webhookToken?: string | null
  readonly webhookTokenHeader?: string
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
  /** Send as the `callbackSecretHeader` header; admin-only, null for members. */
  readonly callbackSecret?: string | null
  readonly callbackSecretHeader?: string
  readonly hasTableWebhook?: boolean
  readonly hasApiKey?: boolean
  readonly newRowConceptId?: string | null
  readonly newRowAutoCreate?: boolean
  readonly lastValidatedAt?: string | null
  readonly lastError?: string | null
}

/** Result of pushing a record version into Clay (async — enriched data returns later). */
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
  createConcept: (
    name: string,
    color?: string | null,
    access?: ReadonlyArray<{ roleId: string; view: boolean }>,
  ) => call((c) => c.createConcept({ name, color, access })),
  updateConcept: (
    id: string,
    patch: {
      name?: string
      pluralName?: string | null
      description: string | null
      icon?: string | null
      color?: string | null
      versioningEnabled?: boolean
      editReach?: EditReach
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
        editReach: patch.editReach,
        staticLabelIds: patch.staticLabelIds,
        defaultLabelIds: patch.defaultLabelIds,
      }),
    ),
  setConceptRecordView: (id: string, recordView: RecordViewLayout | null) =>
    call((c) => c.setConceptRecordView({ id, recordView })),
  setConceptTitleField: (id: string, titleFieldId: string | null) =>
    call((c) => c.setConceptTitleField({ id, titleFieldId })),
  /** Set who may READ a concept's records. Admin-only; applied immediately (not
   *  part of the batched `updateConcept` save). */
  /** Set who may READ one field's values. Admin-only; applied immediately. */
  setFieldVisibility: (id: string, visibility: "visible" | "admin") =>
    call((c) => c.setFieldVisibility({ id, visibility })),
  setConceptVisibility: (id: string, visibility: "visible" | "admin") =>
    call((c) => c.setConceptVisibility({ id, visibility })),
  /** Toggle single-record mode. `fields` seeds the record created when switching
   *  on — pass the concept's required-field values, or the whole call rolls back. */
  setConceptSingleRecord: (
    conceptId: string,
    singleRecord: boolean,
    fields?: Record<string, unknown>,
  ) => call((c) => c.setConceptSingleRecord({ conceptId, singleRecord, fields })),
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
  getRecordGraphLayout: (recordId: string) => call((c) => c.getRecordGraphLayout({ recordId })),
  saveRecordGraphLayout: (recordId: string, positions: GraphLayout) =>
    call((c) => c.saveRecordGraphLayout({ recordId, positions })),
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
  listRecords: (conceptId: string, opts?: { includeArchived?: boolean }) =>
    call((c) => c.listRecords({ conceptId, includeArchived: opts?.includeArchived })),
  getRecord: (id: string) => call((c) => c.getRecord({ id })),
  getSingleRecord: (conceptId: string) => call((c) => c.getSingleRecord({ conceptId })),
  getChanged: () => call((c) => c.getChanged()),
  listEvents: (input?: { conceptId?: string | null; since?: number; limit?: number }) =>
    call((c) =>
      c.listEvents({ conceptId: input?.conceptId, since: input?.since, limit: input?.limit }),
    ),
  createRecord: (conceptId: string, fields: Fields) =>
    call((c) => c.createRecord({ conceptId, fields })),
  updateRecord: (id: string, expectedVersion: number, patch: Fields) =>
    call((c) => c.updateRecord({ id, expectedVersion, patch })),
  transitionRecord: (id: string, expectedVersion: number, field: string, to: string) =>
    call((c) => c.transitionRecord({ id, expectedVersion, field, to })),
  archiveRecordVersion: (id: string, expectedVersion: number) =>
    call((c) => c.archiveRecordVersion({ id, expectedVersion })),
  restoreRecordVersion: (id: string, expectedVersion: number) =>
    call((c) => c.restoreRecordVersion({ id, expectedVersion })),
  deleteRecordVersion: (id: string) => call((c) => c.deleteRecordVersion({ id })),
  // ── versioning ──────────────────────────────────────────────────────────────
  listVersions: (recordId: string) => call((c) => c.listVersions({ recordId })),
  newVersion: (recordId: string) => call((c) => c.newVersion({ recordId })),
  publishVersion: (id: string, expectedVersion: number) =>
    call((c) => c.publishVersion({ id, expectedVersion })),
  discardDraft: (id: string) => call((c) => c.discardDraft({ id })),
  archiveRecord: (recordId: string) => call((c) => c.archiveRecord({ recordId })),
  restoreRecord: (recordId: string) => call((c) => c.restoreRecord({ recordId })),
  searchRecords: (conceptId: string, query?: string, limit?: number) =>
    call((c) => c.searchRecords({ conceptId, query, limit })),
  createRelation: (input: {
    fieldId: string
    fromId: string
    toRecordId?: string
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
  listAllDashboards: () => call((c) => c.listAllDashboards()),
  listRecordDashboards: (conceptId: string) => call((c) => c.listRecordDashboards({ conceptId })),
  createDashboard: (input: {
    name: string
    icon?: string | null
    scope: "personal" | "org"
    body: DashboardBody
    kind?: "page" | "record"
    conceptId?: string | null
  }) => call((c) => c.createDashboard(input)),
  updateDashboard: (input: {
    id: string
    name?: string
    icon?: string | null
    hidden?: boolean
    scope?: "personal" | "org"
    body?: DashboardBody
    conceptId?: string | null
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
  /** Resolve a document's `@` mentions. Deduped server-side, so join the result
   *  on (kind, targetId) rather than by index. */
  resolveMentions: (refs: ReadonlyArray<MentionTarget>) => call((c) => c.resolveMentions({ refs })),
  /** Everything that mentions this record. Sources the caller may not read are
   *  absent, not placeholdered — see `BacklinkRef`. */
  /** Records-only typeahead for the `@` menu, across every readable concept. */
  searchMentionableRecords: (query: string, limit?: number) =>
    call((c) => c.searchMentionableRecords({ query, limit })),
  listBacklinks: (recordId: string) => call((c) => c.listBacklinks({ recordId })),
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
    recordId?: string
    recordVersionId?: string
    bucketId?: string
    conceptId?: string
    includeArchived?: boolean
    limit?: number
  }) => call((c) => c.listFiles(filter ?? {})),
  archiveFile: (id: string) => call((c) => c.archiveFile({ id })),
  restoreFile: (id: string) => call((c) => c.restoreFile({ id })),
  deleteFile: (id: string) => call((c) => c.deleteFile({ id })),
  /** Discard every file in a Files widget's bucket (widget/dashboard deletion). */
  purgeBucket: (bucketId: string) => call((c) => c.purgeBucket({ bucketId })),
  /** Push the widget's "Also list elsewhere" setting onto the files already in the
   *  bucket. New uploads carry the flag themselves; this catches the existing rows,
   *  so turning sharing off actually hides what's already there. */
  setBucketShared: (bucketId: string, shared: boolean) =>
    call((c) => c.setBucketShared({ bucketId, shared })),
  /** Multipart upload onto a record or into a Files widget's own bucket.
   *  Callers refetch their list — the raw JSON body isn't schema-decoded
   *  like RPC results, so don't return it. */
  uploadFile: async (owner: FileOwner, file: File): Promise<void> => {
    const form = new FormData()
    form.append("file", file)
    const url =
      "recordId" in owner
        ? `/api/items/${owner.recordId}/attachments`
        : `/api/buckets/${owner.bucketId}/attachments?shared=${owner.shared === false ? "false" : "true"}`
    const res = await fetch(url, { method: "POST", body: form })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (body?.error === "ATTACHMENT_TOO_LARGE")
        throw new Error(`"${file.name}" is too large — the limit is ${MAX_UPLOAD_MB} MB`)
      throw new Error(body?.error ? `Upload failed: ${body.error}` : "Upload failed")
    }
  },
  /** Browser-native save (content-disposition: attachment). */
  fileDownloadUrl: (id: string) => `/api/attachments/${id}/download`,
  /** Inline render (img/pdf preview) — same bytes, inline disposition. */
  fileInlineUrl: (id: string) => `/api/attachments/${id}/download?inline=1`,
  // ── Version / update check ──────────────────────────────────────────────────
  /** Advisory: the server polls the registry hourly and caches in memory. */
  getVersion: async (): Promise<VersionInfo> => {
    const res = await fetch("/api/version")
    if (!res.ok) throw new Error("Failed to load version")
    return (await res.json()) as VersionInfo
  },
  // ── Org authentication config (SSO + sign-in methods) ───────────────────────
  /** Unauthenticated: what the sign-in page should render. Booleans only. */
  getPublicAuthMethods: async (): Promise<AuthMethods> => {
    const res = await fetch("/api/auth-config/public")
    // Never block sign-in on this: a failure falls back to offering everything,
    // which is what the page did before it asked at all.
    if (!res.ok) return { passwordEnabled: true, ssoEnabled: true }
    return (await res.json()) as AuthMethods
  },
  getAuthConfig: async (): Promise<AuthConfig> => {
    const res = await fetch("/api/auth-config/sso")
    if (!res.ok) {
      // Say WHICH failure. A bare message here hid a routing bug that 404'd this
      // endpoint (see server/router.ts `isBetterAuthPath`) behind a message that
      // read like a permissions or database problem.
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(
        `Failed to load authentication settings (${body?.error ?? `HTTP ${res.status}`})`,
      )
    }
    return (await res.json()) as AuthConfig
  },
  saveSsoProvider: async (input: SsoProviderInput): Promise<void> => {
    const res = await fetch("/api/auth-config/sso", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      // `message` carries the IdP's own discovery failure, which is the only
      // thing that tells the operator WHICH field is wrong.
      const body = (await res.json().catch(() => null)) as {
        error?: string
        message?: string
      } | null
      throw new Error(authConfigError(body?.error, body?.message))
    }
  },
  deleteSsoProvider: async (): Promise<void> => {
    const res = await fetch("/api/auth-config/sso", { method: "DELETE" })
    if (!res.ok) throw new Error("Failed to remove the SSO provider")
  },
  updateAuthMethods: async (methods: AuthMethods): Promise<void> => {
    const res = await fetch("/api/auth-config/methods", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(methods),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(authConfigError(body?.error))
    }
  },
  // ── Integration settings (per-org toggles) ──────────────────────────────────
  getIntegrationSettings: async (): Promise<IntegrationSettingsPayload> => {
    const res = await fetch("/api/integrations/settings")
    if (!res.ok) throw new Error("Failed to load integration settings")
    return (await res.json()) as IntegrationSettingsPayload
  },
  updateIntegrationSettings: async (patch: IntegrationSettingsPatch): Promise<void> => {
    const res = await fetch("/api/integrations/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(
        body?.error === "FORBIDDEN"
          ? "Only an admin can change these settings."
          : "Failed to save integration settings.",
      )
    }
  },
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
    if (!res.ok) throw await syncError(res, "Google")
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
    if (!res.ok) throw await syncError(res, "PostHog")
  },
  listPosthogPersons: async (): Promise<ReadonlyArray<PosthogPerson>> => {
    const res = await fetch("/api/integrations/posthog/persons")
    if (!res.ok) throw new Error("Failed to load PostHog persons")
    const body = (await res.json()) as { persons: ReadonlyArray<PosthogPerson> }
    return body.persons
  },
  // ── Analytics (aggregated queries for the `analytics` widget) ────────────────
  runAnalyticsQuery: async (input: AnalyticsQueryInput): Promise<AnalyticsResult> => {
    const res = await fetch("/api/integrations/analytics/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string
        detail?: string | null
      } | null
      throw new AnalyticsQueryError(
        body?.error ?? "Failed to run analytics query",
        body?.detail ?? null,
      )
    }
    return (await res.json()) as AnalyticsResult
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
    if (!res.ok) throw await syncError(res, "Linear")
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
    if (!res.ok) throw await syncError(res, "Slack")
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
  /** Enrich a record version's fields from Apollo via an {apolloKey → fieldId} mapping. */
  enrichApolloRecord: async (input: {
    recordVersionId: string
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
  /** Bulk-import search results as new record versions onto a concept via a mapping. */
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
   * Push a record version into the Clay table via a {clayColumn → fieldId} mapping.
   * Async: enriched data returns later through the Clay callback. (The Details-tile
   * "Send to Clay" button + mapping picker is a deferred follow-up.)
   */
  sendRecordToClay: async (input: {
    recordVersionId: string
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
  // Record version-view layout prefs — always the caller's own row.
  getRecordViewPrefs: () => call((c) => c.getRecordViewPrefs()),
  updateRecordViewPrefs: (body: RecordViewPrefsBody) =>
    call((c) => c.updateRecordViewPrefs({ body })),
  listDeactivatedMembers: () => call((c) => c.listDeactivatedMembers()),
  deactivateMember: (userId: string) => call((c) => c.deactivateMember({ userId })),
  reactivateMember: (userId: string) => call((c) => c.reactivateMember({ userId })),
  // ── automations (writes admin-only server-side) ────────────────────────────────
  listAutomations: (opts?: { includeArchived?: boolean }) =>
    call((c) => c.listAutomations({ includeArchived: opts?.includeArchived })),
  getAutomation: (id: string) => call((c) => c.getAutomation({ id })),
  createAutomation: (input: {
    name: string
    trigger: AutomationTrigger
    conditions?: ReadonlyArray<SidebarCondition>
    match?: "all" | "any"
    actions: ReadonlyArray<AutomationAction>
    enabled?: boolean
  }) => call((c) => c.createAutomation(input)),
  updateAutomation: (input: {
    id: string
    name?: string
    trigger?: AutomationTrigger
    conditions?: ReadonlyArray<SidebarCondition>
    match?: "all" | "any"
    actions?: ReadonlyArray<AutomationAction>
    enabled?: boolean
  }) => call((c) => c.updateAutomation(input)),
  archiveAutomation: (id: string) => call((c) => c.archiveAutomation({ id })),
  restoreAutomation: (id: string) => call((c) => c.restoreAutomation({ id })),
  deleteAutomation: (id: string) => call((c) => c.deleteAutomation({ id })),
  listAutomationRuns: (automationId: string, opts?: { limit?: number }) =>
    call((c) => c.listAutomationRuns({ automationId, limit: opts?.limit })),
  /** Dry run — reports what WOULD happen, writes nothing. */
  testAutomation: (id: string, opts?: { limit?: number }) =>
    call((c) => c.testAutomation({ id, limit: opts?.limit })),

  // ── access control ──────────────────────────────────────────────────────────
  /** Role NAMES — readable by any member (pills, the Share dialog). */
  listRoles: () => call((c) => c.listRoles()),
  rolesOf: (userId: string) => call((c) => c.rolesOf({ userId })),
  /** The rules inside a role — `configure` only. */
  listRules: (roleId: string) => call((c) => c.listRules({ roleId })),
  /** What I may do org-wide. The client can't work this out itself any more — see
   *  the note on the RPC. */
  myAccess: () => call((c) => c.myAccess()),
  roleHolders: (roleId: string) => call((c) => c.roleHolders({ roleId })),
  reassignRoleHolders: (fromRoleId: string, toRoleId: string) =>
    call((c) => c.reassignRoleHolders({ fromRoleId, toRoleId })),
  createRole: (
    name: string,
    description?: string,
    startFrom?: string,
    kind?: "user" | "automation",
  ) => call((c) => c.createRole({ name, description, startFrom, kind })),
  updateRole: (
    id: string,
    patch: {
      name?: string
      description?: string | null
      autoAssign?: boolean
      active?: boolean
    },
  ) => call((c) => c.updateRole({ id, ...patch })),
  deleteRole: (id: string) => call((c) => c.deleteRole({ id })),
  assignRole: (roleId: string, userId: string) => call((c) => c.assignRole({ roleId, userId })),
  unassignRole: (roleId: string, userId: string) => call((c) => c.unassignRole({ roleId, userId })),
  addRule: (input: {
    roleId: string
    effect: "allow" | "deny"
    actions: ReadonlyArray<AccessActionName>
    resourceType: AccessResourceType
    resourceId?: string | null
    conceptId?: string | null
    condition?: AccessCondition | null
  }) => call((c) => c.addRule(input)),
  updateRule: (input: {
    ruleId: string
    effect: "allow" | "deny"
    actions: ReadonlyArray<AccessActionName>
    resourceType: AccessResourceType
    resourceId?: string | null
    conceptId?: string | null
    condition?: AccessCondition | null
  }) => call((c) => c.updateRule(input)),
  listAccessDefaults: () => call((c) => c.listAccessDefaults()),
  setAccessDefault: (input: {
    roleId: string
    resourceType: AccessResourceType
    actions: ReadonlyArray<AccessActionName>
  }) => call((c) => c.setAccessDefault(input)),
  setScopedRules: (input: {
    roleId: string
    resourceType: AccessResourceType
    scopeBy?: "resource" | "concept"
    entries: ReadonlyArray<{
      resourceId: string
      allow: ReadonlyArray<AccessActionName>
      deny: ReadonlyArray<AccessActionName>
    }>
  }) => call((c) => c.setScopedRules(input)),
  removeRule: (ruleId: string) => call((c) => c.removeRule({ ruleId })),
  /** Omit `userId` for yourself — always allowed, no `configure` needed. */
  effectiveAccess: (userId?: string) => call((c) => c.effectiveAccess({ userId })),
  /** Current grants on one resource. Needs `share` on it. */
  listGrants: (resourceType: AccessResourceType, resourceId: string) =>
    call((c) => c.listGrants({ resourceType, resourceId })),
  share: (input: {
    resourceType: AccessResourceType
    resourceId: string
    userId?: string
    roleId?: string
    actions: ReadonlyArray<AccessActionName>
  }) => call((c) => c.share(input)),
  revokeGrant: (grantId: string) => call((c) => c.revoke({ grantId })),
}
