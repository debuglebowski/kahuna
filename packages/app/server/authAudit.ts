import { clientIp, type SecurityEvent, securityEvent, subjectRef } from "./securityLog"

/**
 * Turns BetterAuth's `hooks.after` context into security events.
 *
 * Structural types rather than BetterAuth's own: this file is pure (no DB, no
 * BetterAuth import) so the mapping is testable with plain objects, and a BetterAuth
 * upgrade that reshapes `ctx` shows up as a typecheck error at the one call site in
 * auth.ts instead of leaking through here.
 *
 * Two facts about the hook shape this relies on (verified against the installed
 * `better-auth` — re-check on upgrade):
 *   - `after` hooks run for HTTP requests AND in-process `auth.api.*` calls; only the
 *     HTTP ones carry `ctx.request`. In-process calls are our own code, which logs
 *     its own events with the real actor, so the org mutations below are gated on
 *     `ctx.request` to avoid logging the same act twice.
 *   - an endpoint's thrown `APIError` arrives as `ctx.context.returned`. A throw from
 *     a `before` hook never reaches `after` hooks, so those denials are logged in the
 *     `before` hook itself (auth.ts).
 */
export interface AfterHookContext {
  readonly path?: string
  readonly headers?: Headers
  readonly request?: unknown
  readonly body?: unknown
  readonly context: {
    readonly returned?: unknown
    readonly newSession?: {
      readonly user: { readonly id: string }
      readonly session?: unknown
    } | null
    readonly session?: { readonly user: { readonly id: string } } | null
    readonly responseHeaders?: Headers | null
  }
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)

/** A short, log-safe error code from a thrown APIError, or undefined if it succeeded. */
const failureOf = (returned: unknown): { status: number; code: string } | undefined => {
  const r = asRecord(returned)
  if (!r || typeof r.statusCode !== "number" || r.statusCode < 400) return undefined
  const code = str(asRecord(r.body)?.code) ?? str(r.status) ?? "ERROR"
  return { status: r.statusCode, code: code.slice(0, 80) }
}

/** `?error=<code>` on a failed OIDC callback redirect, restricted to a code alphabet. */
const callbackErrorCode = (ctx: AfterHookContext): string | undefined => {
  const loc =
    ctx.context.responseHeaders?.get("location") ??
    str(asRecord(asRecord(ctx.context.returned)?.headers)?.location)
  const m = loc ? /[?&]error=([a-z0-9_]{1,60})/i.exec(loc) : null
  return m?.[1]
}

/**
 * Callback refusals already logged as `denied` by the gate that refused them
 * (auth.ts) — with more context than this hook has. Logging them again here would
 * record one refusal as two events.
 */
const LOGGED_AS_DENIED = new Set(["SSO_MFA_REQUIRED", "SSO_DOMAIN_NOT_ALLOWED"])

const activeOrg = (ctx: AfterHookContext): string | undefined =>
  str(asRecord(asRecord(ctx.context.newSession)?.session)?.activeOrganizationId) ??
  str(asRecord(asRecord(ctx.context.session)?.session)?.activeOrganizationId)

/**
 * Org-plugin endpoints that change who is in the org or who owns it, when reached
 * directly over `/api/auth/organization/*`. Our own routes (router.ts) cover the
 * in-app paths and log with the acting user.
 */
const ORG_MUTATIONS: Record<string, string> = {
  "/organization/add-member": "member.added",
  "/organization/remove-member": "member.removed",
  "/organization/update-member-role": "member.role_changed",
  "/organization/leave": "member.left",
  "/organization/create-invitation": "invitation.created",
  "/organization/accept-invitation": "invitation.accepted",
  "/organization/cancel-invitation": "invitation.cancelled",
  "/organization/reject-invitation": "invitation.rejected",
  "/organization/update": "org.updated",
  "/organization/delete": "org.deleted",
  "/organization/create": "org.created",
}

export const auditAuthResponse = (ctx: AfterHookContext): void => {
  const path = ctx.path ?? ""
  const failure = failureOf(ctx.context.returned)
  const ip = clientIp(ctx.headers)
  const body = asRecord(ctx.body)
  const sessionUser = ctx.context.newSession?.user.id ?? ctx.context.session?.user.id

  const emit = (e: SecurityEvent) => securityEvent({ ip, route: `POST /api/auth${path}`, ...e })

  // ── sign-in ──────────────────────────────────────────────────────────────────
  if (path === "/sign-in/email") {
    const email = str(body?.email)
    if (failure) {
      emit({
        event: "auth.signin",
        outcome: "failure",
        reason: failure.code,
        subjectRef: email ? subjectRef(email) : undefined,
        detail: { method: "password" },
      })
    } else {
      emit({
        event: "auth.signin",
        outcome: "success",
        actor: ctx.context.newSession?.user.id,
        orgId: activeOrg(ctx),
        detail: { method: "password" },
      })
    }
    return
  }

  if (path === "/sign-in/sso") {
    // Initiation only — the redirect to the IdP. The sign-in itself is the callback.
    emit({
      event: "auth.sso.initiated",
      outcome: failure ? "failure" : "success",
      reason: failure?.code,
    })
    return
  }

  if (path.startsWith("/sso/callback")) {
    const ok = Boolean(ctx.context.newSession)
    const reason = ok ? undefined : (callbackErrorCode(ctx) ?? failure?.code ?? "CALLBACK_FAILED")
    if (reason && LOGGED_AS_DENIED.has(reason)) return
    emit({
      event: "auth.signin",
      outcome: ok ? "success" : "failure",
      actor: ctx.context.newSession?.user.id,
      orgId: activeOrg(ctx),
      reason,
      route: "GET /api/auth/sso/callback",
      detail: { method: "sso" },
    })
    return
  }

  // ── session + credential lifecycle ───────────────────────────────────────────
  if (path === "/sign-out") {
    emit({ event: "auth.signout", outcome: failure ? "failure" : "success", actor: sessionUser })
    return
  }

  if (
    path === "/change-password" ||
    path === "/set-password" ||
    path === "/reset-password" ||
    path === "/request-password-reset" ||
    path === "/forget-password"
  ) {
    emit({
      event: `auth.password.${path.slice(1).replace(/-/g, "_")}`,
      outcome: failure ? "failure" : "success",
      actor: sessionUser,
      reason: failure?.code,
    })
    return
  }

  if (
    path === "/revoke-session" ||
    path === "/revoke-sessions" ||
    path === "/revoke-other-sessions"
  ) {
    emit({
      event: `auth.session.${path.slice(1).replace(/-/g, "_")}`,
      outcome: failure ? "failure" : "success",
      actor: sessionUser,
      reason: failure?.code,
    })
    return
  }

  if (path === "/delete-user" || path === "/delete-user/callback") {
    emit({
      event: "account.deleted",
      outcome: failure ? "failure" : "success",
      actor: sessionUser,
      reason: failure?.code,
    })
    return
  }

  // ── org membership, direct-to-BetterAuth only ────────────────────────────────
  const orgEvent = ORG_MUTATIONS[path]
  if (orgEvent && ctx.request) {
    emit({
      event: orgEvent,
      outcome: failure ? "failure" : "success",
      actor: sessionUser,
      orgId: str(body?.organizationId) ?? activeOrg(ctx),
      targetKind: "member",
      targetId: str(body?.memberId) ?? str(body?.userId) ?? str(body?.invitationId),
      reason: failure?.code,
      // A role is org vocabulary (`owner`, `member`), not a secret.
      detail: { role: str(body?.role) },
    })
  }
}
