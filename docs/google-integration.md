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
- `GOOGLE_WATCH_ENABLED`: deployment DEFAULT for Calendar watch renewal (opt-in —
  set `1` to default it on). Per-org override as above. The hourly renewal loop
  now always runs and skips orgs whose effective value is off.
- `GOOGLE_WEBHOOK_BASE_URL`: public app origin for Calendar webhooks.
- `GOOGLE_PUBSUB_TOPIC`, `GOOGLE_PUBSUB_VERIFICATION_TOKEN`: Gmail push only. No
  effect while Gmail is disabled (see below); leave unset.

## Manual Setup

1. Create a Google Cloud project.
2. Configure OAuth consent screen.
3. Add authorized redirect URI: `https://<host>/api/integrations/google/callback`.
4. Create OAuth client ID/secret.
5. Enable Google Calendar API. Do not enable the Gmail API.
6. Add test users while OAuth app is in testing.
7. For Calendar push, expose `/api/integrations/google/calendar/push`.

## Scopes

Connect requests only the capabilities the org has enabled, and the only
capability is **Calendar**. See [integration-permissions.md](integration-permissions.md)
for the model.

| Capability | Scope requested | Enables |
| --- | --- | --- |
| `calendar` (default) | `calendar.events` | Calendar sync; create/update events |

## Gmail is disabled

Gmail cannot be turned on: no setting, env var or API call enables it. It is
blocked in layers, so lifting one does not lift the rest:

- **No capability.** `gmail.*` is not in the capability registry
  (`server/integrations/capabilities.ts`), so connect never requests a Gmail scope,
  the settings API rejects the ids, a selection stored by an older build is ignored,
  and a connection is never treated as granted Gmail even if its token still carries
  the scope.
- **Routes refuse.** `GET /gmail/threads`, `GET /gmail/threads/:id` and
  `POST /gmail/send` answer `410 GMAIL_DISABLED`. `POST /gmail/push` answers the
  same after its token check, and writes nothing.
- **Nothing syncs.** Sync, watch renewal and the profile lookup skip Gmail.
- **The transport refuses.** Every Google request goes through one function, which
  throws before any Gmail URL (either host) is called.

Upgrading an existing deployment:

1. Run `bun run db:migrate`. Migration `0026` deletes mirrored Gmail rows (threads,
   messages, sync cursors, record links) and removes the subject, sender and time
   from the Email records and from the event log, including for records purged
   earlier. Email records are archived, not deleted; user-added fields on that
   concept are left alone. The concept itself stays (empty).
2. Remove any Pub/Sub subscription that pushes to this server. It gets 410 until
   you do.
3. A connection made while Gmail was on still holds a token that carries the
   Gmail scopes at Google. Kahuna ignores them, but the grant stays until the person
   reconnects Google (the connect screen then asks for Calendar only) or removes
   the app at their Google account.
4. The connected address is no longer filled in: it came from the Gmail profile
   call, which needs a Gmail scope.

Before Gmail is turned on again, the following must exist and be tested. They did
not when it was disabled:

- Mail private to the mailbox owner by default. Today a mirrored thread becomes a
  record in an org-wide concept, readable by every member through the built-in
  Member role.
- Owner-set rules that make selected mail visible, and exclusions by thread, label
  and contact.
- Only metadata stored. Snippets, the raw API response and message bodies were
  stored (bodies after a thread was opened), and bodies were stored twice.
- A removal path that also scrubs the event log. Record purge keeps events, so a
  purged email record kept its subject and sender there.
- Thread-to-person matching. `google_object_link` is read by retention and never
  written, so no thread was ever linked.
- Disconnect and member removal that stop the sync and remove the mirror. Removing a
  member did not touch their connection.
- A send log with the message id, recipient count and failures.

The code is kept (`google.ts`, the tables, `GMAIL_CAPABILITIES_DISABLED`), but the
behaviour tests for it were removed because they asserted the behaviour above. To
re-enable, move the definitions into `GOOGLE_CAPABILITIES`, which lifts every layer
at once, and only after those controls are in.

## Sync + Watches

- Calendar sync stores `nextSyncToken`; HTTP 410 clears the token and triggers full resync.
- Calendar push carries channel headers only; handler dedupes and runs incremental sync.
- Renewal runs hourly, per connection, for orgs whose effective
  `googleWatchEnabled` is on (`GOOGLE_WATCH_ENABLED=1` is the default).

References:

- Calendar scopes: https://developers.google.com/workspace/calendar/api/auth
- Calendar sync: https://developers.google.com/workspace/calendar/api/guides/sync
- Calendar push: https://developers.google.com/workspace/calendar/api/guides/push
