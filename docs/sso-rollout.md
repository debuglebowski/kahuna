# Single sign-on rollout and recovery

Kahuna has no MFA of its own. To get MFA (and central joiner/leaver control, and
no shared accounts), sign in through your identity provider (IdP) over OIDC and
enforce MFA there. This page covers enabling SSO, turning local password login
off, and getting back in if SSO breaks.

## How sign-in is enforced

Per-org toggles live in `org_auth_settings` (`password_enabled`, `sso_enabled`).
An org with no row gets password on, SSO off. Both gates run in a BetterAuth
`before` hook (`server/auth.ts`), before any session exists:

| Request | Refused when | Error |
|---|---|---|
| `POST /sign-in/email` | none of the address's orgs allow password, **and** the address is not an owner of any org | 403 `PASSWORD_SIGN_IN_DISABLED` |
| `POST /sign-in/sso` | the org that owns the resolved provider has SSO off | 403 `SSO_DISABLED` |

Also enforced:

- Only an org **owner** can change these settings (Settings → Authentication).
- Both off is rejected (`NO_SIGN_IN_METHOD`); SSO on with no registered
  provider is rejected (`NO_SSO_PROVIDER`).
- Removing the provider forces password back on and SSO off.
- SSO accepts only identities whose email domain is one the provider was
  registered for (`SSO_DOMAIN_NOT_ALLOWED`). New SSO users join as plain
  `member`; roles are taken from the IdP only if the operator turns that on
  (see "Roles from the identity provider"), which also makes SSO the only way in.
- Turning password off does **not** end existing sessions. Cookies issued
  earlier stay valid until they expire or are revoked.

**Owner fallback.** By default an address that owns an org can sign in with a
password whatever the toggles say (`owner_password_fallback`, default on). This
is the recovery path: an owner who breaks the IdP config can still get in and
fix it. The consequence is that owner accounts are **not** covered by IdP MFA
unless the fallback is turned off (see "Owners and MFA").

## Provider from deployment config (recommended)

Set `SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` and `SSO_DOMAINS` (all four
or none; `.env.production.example`). The provider is then fixed by whoever deploys,
and Settings → Authentication shows it read-only: an owner session cannot point the
org at another IdP.

That is also what makes account linking work with Entra. An existing account (the
bootstrap admin, anyone provisioned before SSO) is linked on its first SSO sign-in
only when the provider is trusted or the IdP asserts `email_verified`. Entra never
asserts it, so a provider registered in Settings fails those sign-ins with
`account_not_linked`. The deployment-config provider is trusted for the domains in
`SSO_DOMAINS`, and only for those.

- Redirect URI to register at the IdP: `<BETTER_AUTH_URL>/api/auth/sso/callback/deployment-idp`.
- Entra issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0` (single tenant).
- New people who sign in through it join the org as `member`.
- Kahuna reads the issuer's discovery document itself and verifies the ID token;
  no `TRUSTED_ORIGINS` entry is needed for the IdP.

In the rollout below, step 3 is then done by the deploy, not in Settings.

## Rollout

1. **Sign in with the bootstrap admin** (`INITIAL_ADMIN_EMAIL` /
   `INITIAL_ADMIN_PASSWORD`). This account is an owner.
2. **Create your own named owner account** in Settings → Members and promote it
   to `owner`. Do not keep working as the bootstrap admin: shared accounts defeat
   audit trails. Every person with admin rights should have their own account.
3. **Register the provider** in Settings → Authentication → Single sign-on:
   issuer (https), email domain(s), client id, client secret. At the IdP,
   register the redirect URI shown on that page. It is derived from the org id
   and does not change when you edit the provider. Require MFA for the Kahuna
   application in the IdP.
4. **Verify SSO sign-in** while password is still on. Enable SSO (password
   still on), then in a private window sign in with SSO as a non-owner test user.
   Confirm you land in the org, with the `member` role, and that the sign-in
   shows in the security log (`auth.signin`, `detail.method: sso`). Check an
   existing user links to their existing account rather than creating a
   duplicate (the IdP must assert `email_verified`).
5. **Disable password login.** Turn password off, SSO on. Confirm a member's
   password sign-in now fails with `PASSWORD_SIGN_IN_DISABLED` and that SSO
   still works.
6. **Retire the bootstrap admin.** Remove `INITIAL_ADMIN_*` from the environment
   and delete or demote the account (promote your named owner first; the last
   owner cannot be removed). The bootstrap only runs on an empty deployment, so
   it will not recreate it.
7. **Protect the owner passwords.** Unless you turned the owner fallback off, owners can still use a password. Give each a
   long, unique password held in a password manager, keep the number of owners
   small, and watch for `auth.signin` events with `detail.method: password` for
   owner addresses in the security log (`docs/security-logging.md`).

## If SSO breaks

Symptoms: members get an IdP error or a loop; the IdP is down, the client
secret expired, or the issuer changed. Members cannot use passwords while
password is off.

1. **An owner signs in with their password.** This works even with password
   off, unless the owner fallback was turned off (then skip to the server steps).
2. In Settings → Authentication, either fix the provider (re-enter issuer,
   client id and secret) and test, or turn **password back on** to restore
   access for everyone while you fix it. Changing the toggles needs no provider
   (password on, SSO off is always accepted).
3. Re-run steps 4-5 above once the IdP is healthy.

If you cannot sign in as an owner (password forgotten, no owner left able to
sign in), you need operator access to the server:

- Reset an owner's password: `bun packages/app/scripts/reset-password.ts
  <email> <newPassword>`, run with `DATABASE_URL` pointing at the deployment.
  There is no email-based reset.
- Re-enable password for the org directly in the database:
  `UPDATE org_auth_settings SET password_enabled = true, sso_enabled = false
  WHERE org_id = '<org id>';`

Take a backup before editing the database by hand. Operator scripts and manual
SQL do not appear in the application security log; record them in your change
log.

## Roles from the identity provider (optional)

Off by default. When the operator turns it on, the identity provider decides who
holds which role: Kahuna takes roles from a claim in the verified ID token at every
sign-in, and again at least once an hour after that. It uses the shared
`@normain/idp-role-contract` 0.1.0 (vendored, `vendor/normain-idp-role-contract-0.1.0.tgz`,
SHA-256 `f54ba7da94b0330ac83f13349ac8330bed82ef7489c4576c80567e7bf0ae9fe0`), the same
release Cloudable and SlayZone pin.

It applies only to the provider from deployment config (`SSO_*` above). It works
with any OIDC IdP that puts roles in an ID token claim and issues refresh tokens
(Entra ID, Okta, Keycloak, Auth0, …).

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `IDP_ROLES_ENABLED` | `false` | `true` turns the mode on. Needs the four `SSO_*` variables. |
| `IDP_ROLE_CLAIM` | (required when on) | The claim holding the roles. A claim name, or a dotted path into a nested claim (`realm_access.roles`). An exact claim name is matched before a path, so a name containing dots works. |
| `IDP_ROLE_MAPPING` | (required when on) | A JSON object: claim value → array of Kahuna targets, e.g. `{"Kahuna.Admin":["admin"],"Kahuna.Member":["member"]}`. A target is `owner`, a role's key (`admin`, `member`) or a role's id. Role names are not accepted (they can be renamed). Values match exactly, case-sensitive. An empty array grants nothing. |
| `IDP_RECHECK_INTERVAL_SECONDS` | `3600` | How old role evidence may get. 1–3600; more than 3600 is refused. |

The server refuses to start on: a malformed value, mode on with no mapping, a
target that names no role, the mode without `SSO_*`, or any of the names this
feature used during development (see Migration). With the mode off, malformed
`IDP_*` values are still refused.

Startup also records the **activation** in the database (`idp_role_activation`):
turning the mode on, or changing its configuration (claim, mapping, interval,
issuer or client id), starts a new epoch and ends every human session and CLI
credential once. Restarting with the same configuration changes nothing. Turning
the mode off is recorded too, so turning it back on is a new activation.

### What the IdP controls

- **People roles.** At each verified sign-in and each hourly revalidation the person
  holds exactly the roles the claim maps to; any other people role is removed.
  Several mapped values grant all their roles. Auto-assign is not used.
- **Owner.** Owner vs member always follows the claim while the mode is on: with no
  value mapped to `owner`, nobody is an owner, and existing owners become members at
  their next verification.
- **Not controlled:** role definitions and their rules, each member's personal
  overrides, automation roles and automations, and anything else in the app. Do not
  read "the IdP manages roles" as "the IdP controls every permission".

### Sign-in, freshness and removal

- **SSO only.** Password sign-in is refused for everyone, owners included; the owner
  password fallback does not apply. Recovery is server administration (below).
  Settings → Authentication shows this effective state read-only, with a note; the
  stored toggles are kept and apply again if the mode is turned off.
- **No mapped role** (missing or malformed claim, or no mapped value): the sign-in is
  refused (`SSO_NO_MAPPED_ROLE`), the person's roles and owner tier are removed, and
  every session they hold — browser and CLI — is ended. A refusal older than the
  evidence already recorded changes nothing; a newer one also blocks any older
  mapped assertion delivered later.
- **Hourly.** Every authenticated request (web, RPC, CLI, live updates, BetterAuth's
  own endpoints) checks the stored evidence time — the signed `iat` of the last
  verified ID token. At `iat + interval` Kahuna spends the stored refresh token and
  verifies the new ID token (signature, issuer, audience, subject, time). Roles are
  updated from it. If the refresh fails, returns no ID token, or the claim maps to
  nothing, the person must sign in again: their sessions end and their managed roles
  are cleared. An open live-update stream is closed at the deadline.
- **Evidence must postdate the activation.** An ID token signed before the current
  activation — a sign-in that was in progress when the mode was turned on or its
  config changed, or a cached/replayed token — is refused, and so is one older than
  a refusal already recorded for that person. `iat` has one-second resolution, so a
  token signed in the activation's own second is refused too; signing in again a
  second later works.
- A failed hourly refresh records no new cutoff (it is not signed evidence of lost
  roles): a sign-in that was already under way and is newer than the last verified
  evidence still completes.
- One refresh at a time per person, across servers. Kahuna keeps the refresh token
  itself (encrypted) and clears the plugin's copy; BetterAuth's `/refresh-token`,
  `/get-access-token` and `/account-info` are refused in managed mode.

### What is refused in the app

HTTP 409 `ROLES_MANAGED_BY_IDP`, "Roles are managed by your identity provider.",
from the UI (controls hidden), the API and the CLI:

- giving, removing or reordering a person's roles; moving holders between people roles;
- making or removing an owner (`POST /api/org/members/:id/role`, and BetterAuth's
  `/organization/update-member-role`, `/add-member`, `/create-invitation`,
  `/accept-invitation`).

### Audit

One security log line per role decision and refusal, in the shared contract's shape:
`event` (`idp_roles.granted`, `.denied`, `.revalidated`, `.local_change_refused`,
`.activation`), `service` (`kahuna`), `actor`, `subject` (user id), `source`,
`previousGrants`, `newGrants`, `reason`. No tokens or claims are logged. See
`docs/security-logging.md`.

### Rolling out and running several servers

Every server checks the database's activation on every request and refuses
(`503 IDP_ROLES_CONFIG_MISMATCH`) when its own configuration differs — including a
server still running with the mode off after another turned it on. Roll out the same
`IDP_*` values to every server together, and expect requests that reach a not-yet-updated
server during the rollout to be refused rather than served under the old rules.
Sign-ins handled by such a server are not honoured afterwards.

### Recovery

There is no in-app way around the IdP while the mode is on. To regain access:
fix the role assignment at the IdP, or, on the server, set `IDP_ROLES_ENABLED=false`
and restart (password sign-in and in-app roles return; turning the mode on again
ends every session once more). `scripts/reset-password.ts` still works for that.

### Example: Entra ID

1. App registration → **App roles**: create `Kahuna.Admin`, `Kahuna.Member` (and
   `Kahuna.Owner` if owners should come from Entra), allowed member types
   Users/Groups.
2. Enterprise applications → Kahuna → **Users and groups**: assign people or groups to
   them. Optionally set **Assignment required**.
3. Entra puts assigned app roles in the ID token's `roles` claim. Keep the `amr`
   optional claim from the MFA setup. Kahuna asks for `offline_access` in this mode,
   so Entra issues the refresh token the hourly check spends.
4. Configure:

   ```
   IDP_ROLES_ENABLED=true
   IDP_ROLE_CLAIM=roles
   IDP_ROLE_MAPPING={"Kahuna.Owner":["owner"],"Kahuna.Admin":["admin"],"Kahuna.Member":["member"]}
   IDP_RECHECK_INTERVAL_SECONDS=3600
   ```

5. Restart and sign in through SSO. Check Settings → Members and the
   `idp_roles.granted` log line. Remove the role in Entra: within an hour the next
   request ends the session (`idp_roles.denied`).

Okta: add a `groups` (or roles) claim to the ID token. Keycloak: a realm-role mapper
with "Add to ID token", or `IDP_ROLE_CLAIM=realm_access.roles`.

### Migration from the development names

The names below were never released; the server refuses to start while any is set.

| Old | New |
|---|---|
| `SSO_ROLES_FROM_IDP=true` | `IDP_ROLES_ENABLED=true` |
| `SSO_ROLE_CLAIM` (default `roles`) | `IDP_ROLE_CLAIM` (no default) |
| `SSO_ROLE_MAP=A=admin,B=member` | `IDP_ROLE_MAPPING={"A":["admin"],"B":["member"]}` |
| `SSO_ROLE_UNMAPPED=deny\|<role>` | removed — always deny, no fallback role |
| owner managed only when mapped | owner always managed |
| roles at sign-in only | at sign-in and at most every 3600 s |


## Owners and MFA (optional hardening)

By default owners keep the password fallback, so they are not covered by IdP
MFA. To close that, an owner can untick **Owners can use a password** in
Settings → Authentication once SSO is on and you have signed in through SSO
successfully. The server refuses to turn it off while SSO is off. Default is on.

With it off, owners are bound by the same toggles as everyone, and recovery is
operator-only (the steps under "If SSO breaks" that need server access).
Removing the SSO provider turns it back on.
