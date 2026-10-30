# Security Event Logging

Security-relevant events are written to **stdout as one JSON object per line**.
Container platforms (Azure Container Apps, ECS, Kubernetes, `docker logs`) collect
stdout/stderr into their log store, so no agent or file shipping is needed. The
server's other console output (startup, shutdown, error text) is free text on the
same streams. Filter security events with `"type":"security"`.

Source: `server/securityLog.ts` (emitter), `server/authAudit.ts` (BetterAuth
hooks), `server/rpcAudit.ts` (RPC layer). The integration audit tables
(`*_audit_log`) are unchanged and are subject to the retention periods in
`data-retention.md`; the stdout stream is how you keep these events longer than
that, in your own store.

## Format

```json
{"ts":"2026-10-10T17:23:54.966Z","type":"security","level":"warn","service":"kahuna","event":"auth.signin","outcome":"failure","reason":"INVALID_EMAIL_OR_PASSWORD","ip":"203.0.113.9","subjectRef":"9f2c61d0a47be3c1","route":"POST /api/auth/sign-in/email","detail":{"method":"password"}}
```

| Field | Meaning |
|---|---|
| `ts` | ISO-8601 UTC. |
| `type` | Always `security`. |
| `level` | `info` for `success`, `warn` for `failure` and `denied`. |
| `event` | Stable dotted name, see the catalogue. |
| `outcome` | `success`, `failure` (attempted, did not complete) or `denied` (refused by policy). |
| `actor` | User id of who did it. Absent when unknown (failed sign-in, operator CLI). |
| `orgId` | Organization id. |
| `targetKind`, `targetId` | What was acted on, by id (`user`, `role`, `rule`, `sso_provider`, `integration`). |
| `reason` | Short machine code, never free text. |
| `ip` | The `x-forwarded-for` entry your proxy appended — the `TRUSTED_PROXY_HOPS`-th from the right (default 1). The same address the sign-in rate limiter keys on. Entries to its left are client-written and never used. |
| `subjectRef` | HMAC of the email, for failed attempts with no resolved user. Correlates repeats against one account without logging the address. Keyed with `BETTER_AUTH_SECRET`, so it differs per deployment. |
| `route` | `METHOD /path`, query string removed. |
| `detail` | Small flat object of booleans, numbers and short strings. |

Never logged: passwords, tokens, cookies, secrets, request bodies, record or
message content, email addresses, provider error text. `detail` keys that look
sensitive (`password`, `token`, `secret`, `key`, `email`, `message`, `body`,
`content`, ...) are dropped by the emitter regardless of what a caller passes.
Values are clipped to 200 characters and newlines are JSON-escaped, so input
cannot forge a second line. The emitter never throws.

## Events

**Authentication**

| Event | Outcomes | Notes |
|---|---|---|
| `auth.signin` | success, failure, denied | `detail.method` is `password` or `sso`. SSO is logged at the callback, where the session is minted. `denied` reasons: `PASSWORD_SIGN_IN_DISABLED`, `SSO_DOMAIN_NOT_ALLOWED`. |
| `auth.sso.initiated` | success, failure, denied | Redirect to the IdP started. `denied`: `SSO_DISABLED`. |
| `auth.signout` | success | |
| `auth.password.*` | success, failure | `change_password`, `set_password`, `reset_password`, `request_password_reset`. |
| `auth.session.*` | success, failure | `revoke_session`, `revoke_sessions`, `revoke_other_sessions`. |
| `account.deleted` | success, failure | Self-service account deletion. |
| `account.provisioned` | success | Account created by the operator CLI or first-boot bootstrap. |
| `cli.device.approved` | success | A person approved a CLI sign-in; the CLI receives their session. |

**Authorization**

| Event | Outcome | Notes |
|---|---|---|
| `authz.denied` | denied | An authenticated actor was refused. `reason`: `FORBIDDEN`, `NOT_A_MEMBER` or `DEACTIVATED`. For RPC calls `detail.rpc` names the call; for HTTP routes `route` and, where known, `detail.required` (`admin`, `owner`, `configure:org`, `configure:member`) say what was needed. Covers every RPC that fails `FORBIDDEN`, including per-record access checks, and every refused use-case on a plain-HTTP route (attachment upload and download, member purge). |
| `webhook.rejected` | denied | An inbound integration request failed its routing token, signature, channel check, or arrived malformed (Google calendar push). `targetId` is the connector. The presented token is never logged. |
| `integration.oauth.rejected` | denied | A signed-in user's OAuth callback failed: unknown or expired `state` (`BAD_STATE`), state minted for another session (`STATE_SESSION_MISMATCH`), wrong Slack workspace (`TEAM_MISMATCH`). A mismatched state is the signature of a forged callback. |

**Access and membership changes**

| Event | Notes |
|---|---|
| `member.added`, `member.removed`, `member.role_changed` | `member.role_changed` is the owner toggle; `detail` has `from` and `to`. |
| `member.deactivated`, `member.reactivated` | |
| `access.role.created`, `.updated`, `.deleted`, `.assigned`, `.unassigned` | `targetId` is the user for assignments, else the role. |
| `access.rule.added`, `.updated`, `.removed`, `access.role_rules.replaced` | `targetId` is the rule or role. |
| `access.member_roles.reordered`, `access.personal_role.ensured`, `access.role_holders.reassigned` | |
| `member.left`, `invitation.*`, `org.updated`, `org.deleted` | When called directly on `/api/auth/organization/*`. |
| `org.created`, `org.updated`, `org.purged` | Provisioning, rename or logo change, deletion. |

Failures are logged with `outcome:"failure"` where the code path can observe one
(member add, role change, removal, SSO save). RPC changes are logged on success;
a refused RPC shows up as `authz.denied`.

**Schema and workspace configuration** (admin-gated RPCs, logged on success)

| Event | Notes |
|---|---|
| `schema.concept.*` | `created`, `updated`, `title_field_set`, `single_record_set`, `archived`, `restored`, `deleted`. |
| `schema.field.*`, `schema.label.*` | Field `added`, `updated`, `archived`, `restored`, `deleted`, `reordered`; label `created`, `renamed`, `archived`, `restored`, `deleted`. |
| `config.task_status.*`, `config.task_priority.*`, `config.annotation_field.*` | `created`/`added`, `updated`, `archived`, `restored`, `reordered`. |
| `automation.*` | `created`, `updated`, `archived`, `restored`, `deleted`. Automations write to everyone's records. |
| `record.version.deleted` | Admin-gated deletion of a record version. |

Only the RPC name and the target id are logged, never names or values. `rpcAudit.test.ts` fails if an admin-gated RPC is added without being audited or declared a read, so this list cannot silently fall behind.

**Authentication configuration**

| Event | Notes |
|---|---|
| `sso.provider.saved`, `sso.provider.deleted` | Owner only. No issuer, domain, client id or secret in the line. |
| `auth.methods.updated` | `detail.localSignIn` and `detail.ssoSignIn` are the new toggles. |

**Integrations**

| Event | Notes |
|---|---|
| `integration.connect`, `integration.disconnect` | `targetId` is the connector (`google`, `linear`, `slack`, `posthog`, `apollo`, `clay`). |
| `integration.user.connect`, `integration.user.disconnect` | Per-user Slack token. |
| `integration.post_message`, `integration.post_message.user`, `integration.writeback.update`, `integration.writeback.close` | Writes pushed out to a third party. |
| `integration.gmail.send` | Not emitted while Gmail is disabled; the send route answers 410 before it runs. |
| `integration.settings.updated` | `detail.fields` lists which settings changed, not their values. |

## Operating notes

- **Client IP.** The proxy must forward the client address in `x-forwarded-for`
  (the same requirement as rate limiting). Overwriting (the bundled Caddyfile) and
  appending (Azure Container Apps ingress, nginx `$proxy_add_x_forwarded_for`) both
  work: Kahuna reads from the right. Set `TRUSTED_PROXY_HOPS` to the number of
  proxies that append — 2 with a proxying CDN in front of the ingress, or every
  client is logged and throttled as the CDN. Without the header `ip` is absent and
  BetterAuth throttles all sign-ins as one client.
- **Integrity and retention** of the log are the log platform's job. Kahuna
  writes to stdout and does not rotate, sign or delete anything. Send the stream
  to an append-only store with the retention your framework requires.
- **Volume** is low: one line per sign-in, admin action or refusal. A burst of
  `auth.signin` failures or `webhook.rejected` is the signal worth alerting on.

## Not covered

- **Unauthenticated 401s** (no or expired session) on the RPC and HTTP APIs. No
  actor exists and the volume is routine; sign-in failures are covered.
- **Rate-limit rejections** (429). BetterAuth's limiter answers before hooks run.
  Use the proxy or WAF log.
- **Successful data access.** Record reads, exports, and attachment downloads and
  uploads that succeed. Refusals are logged; successes are not, because per-read
  logging is high volume. Record changes are in the in-app event log, not here.
- **Dashboards, saved views and sidebar layout.** These are gated by record-level
  access rules rather than the admin gate, so they are not audited. Concept, field,
  label, task vocabulary and automation changes are.
- **Operator scripts** that touch the database directly (`reset-password`, seed
  and backfill scripts). Only `createUserDirect` and `createOrgDirect` log.
- **Free-text console output** (startup, shutdown, connector errors, membership
  sync failures) is not structured.
