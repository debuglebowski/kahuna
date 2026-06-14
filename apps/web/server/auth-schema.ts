import { relations } from "drizzle-orm"
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * BetterAuth identity tables. The SQL table names are `bauth_`-prefixed so they
 * visually group apart from the engine tables in the DB. The exported consts and
 * BetterAuth model keys stay unprefixed (`user`, `session`, …) — the Drizzle
 * adapter resolves each model by its schema key, so no `modelName` config is
 * needed and the rest of the codebase is unaffected.
 */

export const user = pgTable("bauth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
})

export const session = pgTable(
  "bauth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
)

export const account = pgTable(
  "bauth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
)

export const verification = pgTable(
  "bauth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
)

export const organization = pgTable(
  "bauth_organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: timestamp("created_at").notNull(),
    metadata: text("metadata"),
  },
  (table) => [uniqueIndex("organization_slug_uidx").on(table.slug)],
)

export const member = pgTable(
  "bauth_member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
  ],
)

export const invitation = pgTable(
  "bauth_invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
)

export const googleConnection = pgTable(
  "google_connection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    googleAccountId: text("google_account_id"),
    email: text("email"),
    scopes: text("scopes").notNull().default(""),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    status: text("status").notNull().default("connected"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("google_connection_org_user_uq").on(table.orgId, table.userId),
    index("google_connection_status_idx").on(table.status),
  ],
)

export const googleOAuthState = pgTable(
  "google_oauth_state",
  {
    state: text("state").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    scopes: text("scopes").notNull(),
    returnTo: text("return_to").notNull().default("/settings/integrations"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("google_oauth_state_exp_idx").on(table.expiresAt),
    index("google_oauth_state_user_idx").on(table.orgId, table.userId),
  ],
)

export const googleCalendarSync = pgTable(
  "google_calendar_sync",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => googleConnection.id, { onDelete: "cascade" }),
    calendarId: text("calendar_id").notNull().default("primary"),
    syncToken: text("sync_token"),
    watchChannelId: text("watch_channel_id"),
    watchResourceId: text("watch_resource_id"),
    watchToken: text("watch_token"),
    watchExpiresAt: timestamp("watch_expires_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("google_calendar_sync_conn_calendar_uq").on(table.connectionId, table.calendarId),
    index("google_calendar_watch_exp_idx").on(table.watchExpiresAt),
  ],
)

export const googleCalendarEvent = pgTable(
  "google_calendar_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => googleConnection.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    calendarId: text("calendar_id").notNull().default("primary"),
    googleEventId: text("google_event_id").notNull(),
    etag: text("etag"),
    status: text("status"),
    summary: text("summary"),
    description: text("description"),
    location: text("location"),
    htmlLink: text("html_link"),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    allDay: boolean("all_day").notNull().default(false),
    attendees: jsonb("attendees").notNull().default([]),
    raw: jsonb("raw").notNull().default({}),
    googleUpdatedAt: timestamp("google_updated_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("google_calendar_event_provider_uq").on(
      table.connectionId,
      table.calendarId,
      table.googleEventId,
    ),
    index("google_calendar_event_list_idx").on(table.orgId, table.userId, table.startAt),
  ],
)

export const googleGmailSync = pgTable(
  "google_gmail_sync",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => googleConnection.id, { onDelete: "cascade" }),
    historyId: text("history_id"),
    watchExpiration: timestamp("watch_expiration", { withTimezone: true }),
    lastFullSyncAt: timestamp("last_full_sync_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("google_gmail_sync_conn_uq").on(table.connectionId),
    index("google_gmail_watch_exp_idx").on(table.watchExpiration),
  ],
)

export const googleGmailThread = pgTable(
  "google_gmail_thread",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => googleConnection.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    threadId: text("thread_id").notNull(),
    historyId: text("history_id"),
    subject: text("subject"),
    snippet: text("snippet"),
    fromEmail: text("from_email"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    labelIds: jsonb("label_ids").notNull().default([]),
    raw: jsonb("raw").notNull().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("google_gmail_thread_provider_uq").on(table.connectionId, table.threadId),
    index("google_gmail_thread_list_idx").on(table.orgId, table.userId, table.lastMessageAt),
  ],
)

export const googleGmailMessage = pgTable(
  "google_gmail_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => googleConnection.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id").notNull(),
    historyId: text("history_id"),
    subject: text("subject"),
    fromEmail: text("from_email"),
    toEmail: text("to_email"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    snippet: text("snippet"),
    labelIds: jsonb("label_ids").notNull().default([]),
    payload: jsonb("payload").notNull().default({}),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    raw: jsonb("raw").notNull().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("google_gmail_message_provider_uq").on(table.connectionId, table.messageId),
    index("google_gmail_message_thread_idx").on(table.connectionId, table.threadId),
  ],
)

export const googleObjectLink = pgTable(
  "google_object_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    providerKind: text("provider_kind").notNull(),
    providerId: text("provider_id").notNull(),
    itemId: text("item_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("google_object_link_uq").on(
      table.orgId,
      table.userId,
      table.providerKind,
      table.providerId,
      table.itemId,
    ),
    index("google_object_link_item_idx").on(table.orgId, table.itemId),
  ],
)

export const googleNotification = pgTable(
  "google_notification",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("google_notification_exp_idx").on(table.expiresAt)],
)

export const googleAuditLog = pgTable(
  "google_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectionId: uuid("connection_id"),
    action: text("action").notNull(),
    status: text("status").notNull().default("ok"),
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("google_audit_log_org_idx").on(table.orgId, table.createdAt)],
)

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
}))

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}))

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}))

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
}))

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}))

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}))

/**
 * PostHog integration — the first non-Google connector and the template the
 * later key-based integrations (Linear/Slack/Apollo/Clay) inherit. Unlike
 * Google (per-(org,user) OAuth), PostHog auth is a project API key stored
 * ENCRYPTED at the ORG level: one connection per org. Tables mirror the
 * `google_*` conventions (snake_case SQL names, withTimezone timestamps,
 * `$onUpdate` updatedAt, jsonb raw payloads).
 */
export const posthogConnection = pgTable(
  "posthog_connection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The user who connected — kept for audit/attribution; the connection is
    // org-scoped (uniqueness is on org_id alone).
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Full API base URL, e.g. https://us.posthog.com — region presets resolve
    // to a host, self-host allows any https origin.
    host: text("host").notNull(),
    region: text("region").notNull().default("us"),
    projectId: text("project_id").notNull(),
    projectName: text("project_name"),
    apiKey: text("api_key"),
    // Per-connection secret for the inbound webhook receiver (so PostHog's
    // unauthenticated POSTs can be mapped back to an org).
    webhookToken: text("webhook_token"),
    status: text("status").notNull().default("connected"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("posthog_connection_org_uq").on(table.orgId),
    uniqueIndex("posthog_connection_webhook_token_uq").on(table.webhookToken),
    index("posthog_connection_status_idx").on(table.status),
  ],
)

/**
 * Synced per-person product-usage metrics, keyed by (org, distinct_id). One row
 * per PostHog person; `email` is denormalized so callers can match a person to
 * a Kingsmaker instance by email OR distinct_id without re-parsing properties.
 */
export const posthogPersonMetric = pgTable(
  "posthog_person_metric",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => posthogConnection.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    distinctId: text("distinct_id").notNull(),
    personId: text("person_id"),
    email: text("email"),
    name: text("name"),
    properties: jsonb("properties").notNull().default({}),
    eventCount: integer("event_count").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    raw: jsonb("raw").notNull().default({}),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("posthog_person_metric_org_distinct_uq").on(table.orgId, table.distinctId),
    index("posthog_person_metric_email_idx").on(table.orgId, table.email),
  ],
)

/** Dedupe + audit trail for the inbound webhook receiver. */
export const posthogWebhookEvent = pgTable(
  "posthog_webhook_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id"),
    connectionId: uuid("connection_id"),
    dedupeKey: text("dedupe_key").notNull(),
    eventName: text("event_name"),
    distinctId: text("distinct_id"),
    payload: jsonb("payload").notNull().default({}),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("posthog_webhook_event_dedupe_uq").on(table.dedupeKey),
    index("posthog_webhook_event_org_idx").on(table.orgId, table.receivedAt),
  ],
)

export const posthogAuditLog = pgTable(
  "posthog_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectionId: uuid("connection_id"),
    action: text("action").notNull(),
    status: text("status").notNull().default("ok"),
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("posthog_audit_log_org_idx").on(table.orgId, table.createdAt)],
)

/**
 * Linear integration — a key-based connector built on the PostHog template.
 * Auth is a Linear personal API key stored ENCRYPTED at the ORG level (one
 * connection per org). `webhook_token` routes inbound webhook POSTs back to an
 * org (like PostHog), while `webhook_secret` (also encrypted) is the shared
 * secret Linear signs each delivery with — verified as an HMAC-SHA256 over the
 * raw body. Tables follow the `posthog_*` conventions.
 */
export const linearConnection = pgTable(
  "linear_connection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The user who connected — kept for audit/attribution; the connection is
    // org-scoped (uniqueness is on org_id alone).
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Linear personal API key, encrypted at rest (nulled on disconnect).
    token: text("token"),
    // Per-connection routing token embedded in the webhook URL so Linear's
    // POSTs can be mapped back to this org before signature verification.
    webhookToken: text("webhook_token"),
    // Shared signing secret for inbound webhook HMAC verification, encrypted.
    webhookSecret: text("webhook_secret"),
    // The Linear user the key authenticates as (from the `viewer` query).
    viewerId: text("viewer_id"),
    viewerName: text("viewer_name"),
    status: text("status").notNull().default("connected"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("linear_connection_org_uq").on(table.orgId),
    uniqueIndex("linear_connection_webhook_token_uq").on(table.webhookToken),
    index("linear_connection_status_idx").on(table.status),
  ],
)

/**
 * Synced Linear issues, keyed by (org, linear_id). One row per issue; common
 * generic attributes (identifier/title/state/assignee/team/priority) are
 * denormalized for cheap querying, with the full node preserved in `raw`. No
 * Kingsmaker concept/field mapping happens here — that is deferred.
 */
export const linearIssue = pgTable(
  "linear_issue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => linearConnection.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    // Linear's global issue id (a uuid); `identifier` is the human key, e.g. ENG-123.
    linearId: text("linear_id").notNull(),
    identifier: text("identifier"),
    title: text("title"),
    // Workflow state name + its category type (backlog/unstarted/started/
    // completed/canceled) — the type drives later status mapping, generically.
    state: text("state"),
    stateType: text("state_type"),
    assigneeId: text("assignee_id"),
    assigneeName: text("assignee_name"),
    teamId: text("team_id"),
    teamKey: text("team_key"),
    priority: integer("priority"),
    url: text("url"),
    // Linear-side last-updated timestamp (NOT row-managed).
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    raw: jsonb("raw").notNull().default({}),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("linear_issue_org_linear_uq").on(table.orgId, table.linearId),
    index("linear_issue_org_identifier_idx").on(table.orgId, table.identifier),
    index("linear_issue_org_state_idx").on(table.orgId, table.state),
  ],
)

/** Dedupe + audit trail for the inbound webhook receiver. */
export const linearWebhookEvent = pgTable(
  "linear_webhook_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id"),
    connectionId: uuid("connection_id"),
    dedupeKey: text("dedupe_key").notNull(),
    action: text("action"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    payload: jsonb("payload").notNull().default({}),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("linear_webhook_event_dedupe_uq").on(table.dedupeKey),
    index("linear_webhook_event_org_idx").on(table.orgId, table.receivedAt),
  ],
)

export const linearAuditLog = pgTable(
  "linear_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectionId: uuid("connection_id"),
    action: text("action").notNull(),
    status: text("status").notNull().default("ok"),
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("linear_audit_log_org_idx").on(table.orgId, table.createdAt)],
)

/**
 * Slack integration — an OAuth connector built on the same scaffold, but unlike
 * the key-based PostHog/Linear ones it uses Slack OAuth v2: a workspace admin
 * installs the app and we exchange the code for a bot token (xoxb). The token is
 * stored ENCRYPTED, one connection per ORG (the chosen default — a single
 * workspace per org), with `team_id` recorded so inbound Events API / slash /
 * interactivity POSTs (which carry a team id, not an org) route back here. The
 * OAuth handshake mirrors `google_oauth_state`. Tables follow the
 * `posthog_*`/`linear_*` conventions. KM automation/instance wiring is DEFERRED.
 */
export const slackConnection = pgTable(
  "slack_connection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The user who installed the app — kept for audit/attribution; the
    // connection is org-scoped (uniqueness is on org_id alone).
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Slack workspace id (T...) — routes inbound events back to this org.
    teamId: text("team_id").notNull(),
    teamName: text("team_name"),
    // Enterprise Grid org id, if the install is on an enterprise workspace.
    enterpriseId: text("enterprise_id"),
    appId: text("app_id"),
    // The bot's own user id (U...) so its own messages can be ignored.
    botUserId: text("bot_user_id"),
    // The installing Slack user (authed_user.id).
    authedUserId: text("authed_user_id"),
    // Bot OAuth token (xoxb-...), encrypted at rest (nulled on disconnect).
    botToken: text("bot_token"),
    scopes: text("scopes").notNull().default(""),
    status: text("status").notNull().default("connected"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("slack_connection_org_uq").on(table.orgId),
    // A Slack workspace maps to exactly one org so inbound POSTs route unambiguously.
    uniqueIndex("slack_connection_team_uq").on(table.teamId),
    index("slack_connection_status_idx").on(table.status),
  ],
)

/** OAuth-state handshake rows for the connect→callback redirect (mirrors google). */
export const slackOAuthState = pgTable(
  "slack_oauth_state",
  {
    state: text("state").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    returnTo: text("return_to").notNull().default("/settings/integrations"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("slack_oauth_state_exp_idx").on(table.expiresAt),
    index("slack_oauth_state_user_idx").on(table.orgId, table.userId),
  ],
)

/** Cached workspace channels (from conversations.list) for pickers/automations. */
export const slackChannel = pgTable(
  "slack_channel",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => slackConnection.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    channelId: text("channel_id").notNull(),
    name: text("name"),
    isPrivate: boolean("is_private").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    raw: jsonb("raw").notNull().default({}),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("slack_channel_conn_channel_uq").on(table.connectionId, table.channelId),
    index("slack_channel_org_name_idx").on(table.orgId, table.name),
  ],
)

/**
 * Inbound Events API dedup + log, keyed by Slack's `event_id`. Slack retries
 * deliveries it doesn't get a 2xx for within 3s, so the same event_id can arrive
 * multiple times — the unique key makes reprocessing idempotent. Mirrors the
 * `linear_webhook_event`/`posthog_webhook_event` shape.
 */
export const slackEvent = pgTable(
  "slack_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id"),
    connectionId: uuid("connection_id"),
    dedupeKey: text("dedupe_key").notNull(),
    teamId: text("team_id"),
    eventType: text("event_type"),
    payload: jsonb("payload").notNull().default({}),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("slack_event_dedupe_uq").on(table.dedupeKey),
    index("slack_event_org_idx").on(table.orgId, table.receivedAt),
  ],
)

export const slackAuditLog = pgTable(
  "slack_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectionId: uuid("connection_id"),
    action: text("action").notNull(),
    status: text("status").notNull().default("ok"),
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("slack_audit_log_org_idx").on(table.orgId, table.createdAt)],
)

