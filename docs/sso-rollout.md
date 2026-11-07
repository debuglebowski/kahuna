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
  (see "Roles from the identity provider").
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

Off by default. When the operator turns it on, the identity provider decides
which roles each person holds: Kahuna reads a claim from the verified ID token
at every sign-in and sets the person's roles from it. Roles are still defined
(name, rules) in Settings → Roles; the IdP decides who holds them.

It applies to the provider from deployment config only (`SSO_*` above), so it
can't be turned on from inside the app, and it refuses to boot without that
provider. It works with any IdP that can put the roles in a claim of the ID
token: Entra ID, Okta, Keycloak and others.

| Variable | Default | Meaning |
|---|---|---|
| `SSO_ROLES_FROM_IDP` | `false` | `true` turns the mode on. |
| `SSO_ROLE_CLAIM` | `roles` | The claim that holds the roles. A top-level name, or a dotted path into a nested claim (Keycloak: `realm_access.roles`). A claim name containing dots, such as the SAML role attribute `http://schemas.microsoft.com/ws/2008/06/identity/claims/role`, is matched as a whole name first. |
| `SSO_ROLE_MAP` | (required) | Comma-separated `<claim value>=<role>`. The role is a Kahuna role's key (`admin`, `member`), id, or name (not case-sensitive). The reserved role `owner` makes the person an org owner. Claim values are matched exactly, case-sensitive. Several values may map to one role, and one value to several. |
| `SSO_ROLE_UNMAPPED` | `deny` | What happens when the claim holds no mapped value: `deny` refuses the sign-in, or name one role to give instead. Cannot be `owner`. |

A malformed value (an unknown `SSO_ROLES_FROM_IDP` value, an empty or broken
map) stops the server from starting.

### What happens at sign-in

- The person ends up holding exactly the people roles their claim maps to.
  Roles the claim no longer carries are removed, including roles given in the
  app before the mode was turned on. Auto-assign roles are not handed out.
- If any mapping targets `owner`, owner vs member follows the claim too
  (someone without the owner value is made a plain member). With no `owner`
  mapping, owners are left as they are.
- No mapped value: the sign-in is refused (`SSO_NO_MAPPED_ROLE`). The person's
  roles are removed anyway and their open sessions are ended, so removing every
  role at the IdP takes effect on their next sign-in attempt.
- A mapped value naming a role that doesn't exist counts as unmapped, and is
  logged (`access.role.from_idp`, `failure`, `ROLE_NOT_FOUND`).
- Kahuna does not re-check the IdP between sign-ins. A role removed at the IdP
  is removed in Kahuna the next time that person signs in through it; until
  then an open session keeps the previous roles, for as long as the session
  lasts.

Not governed by the IdP: automation roles, each member's personal overrides,
and the rules inside roles. Password sign-ins don't change roles; turn password
sign-in off (rollout step 5) so everyone goes through the IdP.

### What is refused in the app

With the mode on, these are refused with `ROLES_MANAGED_BY_IDP` and the message
"Roles are managed by your identity provider." — in the UI (the controls are
hidden), over the API and from the CLI:

- giving or removing a person's role (`assignRole`, `unassignRole`);
- reordering a person's roles (`reorderMemberRoles`);
- moving holders of a people role to another role (`reassignRoleHolders`);
- making or removing an owner (`POST /api/org/members/:id/role`), only when
  `owner` is mapped.

Each refusal writes an `access.role_change.refused` security log line, and each
role taken from the claim an `access.role.from_idp` line
(`docs/security-logging.md`).

### Example: Entra ID

1. In the app registration for Kahuna, **App roles → Create app role**, once
   per role: display name `Kahuna admin`, allowed member types **Users/Groups**,
   value `Kahuna.Admin`. Repeat for `Kahuna.Member`, and `Kahuna.Owner` if you
   want owners managed too.
2. In **Enterprise applications → Kahuna → Users and groups**, assign users or
   groups to those roles. Optionally set **Properties → Assignment required** to
   Yes, so people with no role can't get a token at all.
3. Entra puts assigned app roles in the ID token's `roles` claim by default; no
   optional claim is needed. (Keep the `amr` optional claim from the MFA setup.)
4. Configure Kahuna:

   ```
   SSO_ROLES_FROM_IDP=true
   SSO_ROLE_CLAIM=roles
   SSO_ROLE_MAP=Kahuna.Owner=owner,Kahuna.Admin=admin,Kahuna.Member=member
   SSO_ROLE_UNMAPPED=deny
   ```

5. Restart, sign in through SSO as a test user with `Kahuna.Member`, and check
   their roles in Settings → Members and the `access.role.from_idp` log line.
   Then remove the role in Entra, sign in again, and confirm the refusal
   (`auth.signin` denied `SSO_NO_MAPPED_ROLE`).

Other IdPs: Okta — add a `roles` (or `groups`) claim to the ID token in the
authorization server and point `SSO_ROLE_CLAIM` at it. Keycloak — add a realm
role mapper with "Add to ID token", or use `SSO_ROLE_CLAIM=realm_access.roles`.

## Owners and MFA (optional hardening)

By default owners keep the password fallback, so they are not covered by IdP
MFA. To close that, an owner can untick **Owners can use a password** in
Settings → Authentication once SSO is on and you have signed in through SSO
successfully. The server refuses to turn it off while SSO is off. Default is on.

With it off, owners are bound by the same toggles as everyone, and recovery is
operator-only (the steps under "If SSO breaks" that need server access).
Removing the SSO provider turns it back on.
