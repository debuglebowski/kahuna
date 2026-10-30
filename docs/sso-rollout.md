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
  `member`; roles are never taken from the IdP.
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

## Owners and MFA (optional hardening)

By default owners keep the password fallback, so they are not covered by IdP
MFA. To close that, an owner can untick **Owners can use a password** in
Settings → Authentication once SSO is on and you have signed in through SSO
successfully. The server refuses to turn it off while SSO is off. Default is on.

With it off, owners are bound by the same toggles as everyone, and recovery is
operator-only (the steps under "If SSO breaks" that need server access).
Removing the SSO provider turns it back on.
