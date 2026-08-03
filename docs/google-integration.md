# Google Integration

## Env

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `INTEGRATION_ENCRYPTION_KEY`: 32 random bytes, base64 or 64-char hex. Shared
  by every connector, not just Google. Was `GOOGLE_TOKEN_ENCRYPTION_KEY`.
- `GOOGLE_SYNC_ENABLED`: deployment DEFAULT for the org-level sync toggle;
  set `0` to default it off. Per-org overrides live in Settings →
  Integrations (`org_integration_settings`) and win over this. Gates the
  callback backfill, inbound push, and the Sync button.
- `GOOGLE_WATCH_ENABLED`: deployment DEFAULT for watch renewal (opt-in — set
  `1` to default it on). Per-org override as above. The hourly renewal loop
  now always runs and skips orgs whose effective value is off.
- `GOOGLE_WEBHOOK_BASE_URL`: public app origin for Calendar webhooks.
- `GOOGLE_PUBSUB_TOPIC`: Gmail Pub/Sub topic, e.g. `projects/<id>/topics/<topic>`.
- `GOOGLE_PUBSUB_VERIFICATION_TOKEN`: reserved for Pub/Sub push verification.

## Manual Setup

1. Create a Google Cloud project.
2. Configure OAuth consent screen.
3. Add authorized redirect URI: `https://<host>/api/integrations/google/callback`.
4. Create OAuth client ID/secret.
5. Enable Google Calendar API.
6. Enable Gmail API.
7. Add test users while OAuth app is in testing.
8. For Gmail push, create Pub/Sub topic/subscription and push to `/api/integrations/google/gmail/push`.
9. For Calendar push, expose `/api/integrations/google/calendar/push`.
10. Complete Google app verification before production use of sensitive/restricted scopes.

## Scopes

Base connect requests:

- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/gmail.metadata`
- `https://www.googleapis.com/auth/gmail.labels`

On-demand upgrades:

- Mail read: `https://www.googleapis.com/auth/gmail.readonly`
- Mail send: `https://www.googleapis.com/auth/gmail.send`
- Mail compose/drafts: `https://www.googleapis.com/auth/gmail.compose`
- Availability: `https://www.googleapis.com/auth/calendar.freebusy`

Gmail `gmail.metadata`, `gmail.readonly`, `gmail.compose`, and `gmail.modify` are restricted. Server storage/transmission can require a security assessment. `gmail.send` is sensitive. Calendar scopes should stay at `calendar.events` and `calendar.freebusy` unless broader calendar management is explicitly needed.

## Sync + Watches

- Calendar sync stores `nextSyncToken`; HTTP 410 clears the token and triggers full resync.
- Gmail sync stores `historyId`; HTTP 404 triggers full resync.
- Gmail push carries email/history ID through Pub/Sub and enqueues incremental sync.
- Calendar push carries channel headers only; handler dedupes and runs incremental sync.
- Renewal runs hourly, per connection, for orgs whose effective
  `googleWatchEnabled` is on (`GOOGLE_WATCH_ENABLED=1` is the default).

References:

- Calendar scopes: https://developers.google.com/workspace/calendar/api/auth
- Gmail scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Calendar sync: https://developers.google.com/workspace/calendar/api/guides/sync
- Calendar push: https://developers.google.com/workspace/calendar/api/guides/push
- Gmail sync: https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail push: https://developers.google.com/workspace/gmail/api/guides/push
