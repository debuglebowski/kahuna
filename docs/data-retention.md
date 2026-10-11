# Data Retention

A server job (`server/retention-tick.ts`) purges integration audit logs and
integration mirror data once per day. It starts with the server, runs on one
replica without locking, deletes in batches of 1000, and logs the per-table row
counts. Deletes are idempotent, so a second replica would only repeat them.

## Periods

Every period is in days and set by an env var. Unset uses the default; `0`
disables that rule.

| Data | Default | Env var | Counted from |
|---|---|---|---|
| Integration audit logs (`google_`, `posthog_`, `linear_`, `slack_`, `apollo_`, `clay_audit_log`) | 365 | `RETENTION_AUDIT_DAYS` | `created_at` |
| Gmail threads and messages with no record link (Gmail is disabled; rows only exist from before) | 30 | `RETENTION_GMAIL_UNLINKED_DAYS` | message date |
| Rows whose source deleted them (calendar events, Gmail threads and messages) | 30 | `RETENTION_DELETED_UPSTREAM_DAYS` | `deleted_at` |
| Mirror data and sync cursors of disconnected integrations | 30 | `RETENTION_DISCONNECTED_DAYS` | `disconnected_at` |
| Webhook and notification dedupe rows | 30 | `RETENTION_DEDUPE_DAYS` | receipt |
| Finished Clay jobs (`done` / `error`) | 90 | `RETENTION_CLAY_JOB_DAYS` | `pushed_at` |

`RETENTION_TICK_INTERVAL_MS` sets how often the job runs (default one day).

Why these periods:

- **Audit logs** are our own records of who did what through an integration;
  nothing else holds a copy. A year covers a normal audit cycle and incident
  look-back without keeping identifiers indefinitely.
- **Gmail** is disabled (see [google-integration.md](google-integration.md)) and
  migration `0026` removed the mail it had mirrored, so these rules have nothing
  to purge on a current install. They stay as a backstop for the tables. If Gmail
  is ever re-enabled they are NOT enough on their own: they delete mirror rows
  only, not the record projected from a thread or the subject and sender in that
  record's events. As written, copies were kept only while they mattered to a
  record, linked through `google_object_link` (`provider_kind = 'gmail_thread'`,
  `provider_id` = the Gmail thread id). Nothing ever wrote that link, so no thread
  was linked and every copy fell to the grace period.
- **Deleted upstream:** once the source deleted an item, our marker only exists
  so sync can see the deletion; it is removed after the grace period.
- **Disconnected integrations:** disconnecting clears tokens but not data. The
  mirror rows go after the grace period, along with the sync cursors, so a
  reconnect does a full sync rather than an incremental one against rows that
  are gone. The connection row stays. This applies to linked Gmail copies too:
  disconnecting means the data source is no longer authorised.
- **Dedupe rows** only exist to ignore repeat deliveries of the same webhook.
- **Clay jobs** hold enrichment results and have no long-term use. Pending jobs
  are never purged.

The Apollo enrichment cache is not covered here: it already has its own
per-org TTL setting and is cleared on disconnect.

## What is left alone

| Data | Why |
|---|---|
| `events` | Append-only source of truth. Every record state is derived from it, and it feeds live sync and automations. Purging it would break replay and history. |
| `records`, `record_versions` | The business data itself, including versions. Governed by the product's archive and purge actions, not by age. |
| `annotations` | Notes, tasks and activity attached to records; they belong to the record. |
| `automation_runs` | Run history that automations and their users rely on. |
| Live, in-sync mirrors (calendar events, Linear issues, PostHog person metrics) | Kept current by sync, and removed on upstream delete or disconnect. Age alone says nothing about whether they are still valid. |

A mirror can be projected into records (for example Calendar into record
versions, Linear issues into a Ticket concept). Those records are business data
and are outside this job, so purging a mirror row does not delete the record built
from it. The record's events keep the synced values too: record purge keeps the
event log, and there is no payload redaction. For personal data that matters, so
mirror only what you are prepared to keep as a record.

## Erasure requests

There is no pseudonymisation of stored data. A request to erase a person's data
is handled through the retention schedule above plus the normal record
archive/purge actions. Security records (the audit logs) are kept for the
period above, and the legal ground for keeping them is the operator's
legitimate interest and legal obligation to maintain security and access
records (for example GDPR Art. 6(1)(c) and (f), and Art. 17(3)(b) and (e) for
legal obligations and legal claims). Operators should record this ground in
their own retention schedule and may lengthen or shorten the periods with the
env vars to match their policy.
