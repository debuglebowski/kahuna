# Integration permissions

OAuth connectors (Google, Slack user connect) request only the scopes of the
**capabilities** an org has enabled. A capability is what the app may do as the
connected person; it owns the provider scopes that grant it. Defaults are
least-privilege, and anything that reads other people's data or acts as the user
is **sensitive** and off until an org admin opts in.

## Where it lives

- Registry (code): `packages/app/server/integrations/capabilities.ts`. Lists
  each capability's scopes, `sensitive` flag, default, and `implies`. A test
  asserts no sensitive capability is on by default.
- Selection (DB): `org_integration_settings.enabled_capabilities`, e.g.
  `{ "google": ["calendar", "gmail.send"] }`. NULL or a missing key means the
  registry defaults. Not configurable by env.
- UI: Settings → Integrations → **Permissions requested** on the Google and
  Slack cards (admins only). Visible before the first connect.
- API: `GET/POST /api/integrations/settings`, field `capabilities`
  (`{ google: [...] }` replaces, `{ google: null }` resets). Admin-only; changes
  emit an `integration.settings.updated` security event listing the effective
  capabilities.

## Capabilities

| Integration | Capability | Default | Scopes | Sensitive |
| --- | --- | --- | --- | --- |
| google | `calendar` | on | `calendar.events` | no |
| google | `gmail.metadata` | off | `gmail.metadata` | yes |
| google | `gmail.read` | off | `gmail.readonly`; implies `gmail.metadata` | yes |
| google | `gmail.send` | off | `gmail.send` | yes |
| slack (user token) | `chat.write` | on | `chat:write` | no |

Slack **bot** scopes are fixed by the app manifest (`SLACK_SCOPES`) and are not
org-selectable.

## Behaviour to know

- Applies at the next connect. Changing a selection does not revoke an existing
  grant; reconnect to narrow or widen it. Feature gates check the scopes
  actually granted, so a connection without a scope gets a 403, not a silent
  success.
- The Google connect URL's optional `capability=` params can only narrow the
  request, never add a capability the org has not enabled.
- Disabling every capability makes connect return `NO_CAPABILITIES_ENABLED`.
- Slack user scopes are no longer read from `SLACK_USER_SCOPES`; any scope you
  add must also be configured under "User Token Scopes" in the Slack app.

## Adding a capability

Add an entry to the integration's registry, give it the narrowest scope that
works, mark it `sensitive` if it reads others' data or acts as the user (then it
cannot default on), and gate the feature with `hasCapability`. The settings UI
renders it automatically.
