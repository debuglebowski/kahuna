import { and, eq, sql } from "drizzle-orm"
import { member, organization, user } from "#db"
import { MAX_UPLOAD_BYTES, type UploadOwner } from "#engine"
import { queryAnalytics } from "./analytics"
import {
  apolloStatus,
  connectApollo,
  disconnectApollo,
  enrichRecordForRequest,
  importForRequest,
  searchForRequest,
} from "./apollo"
import { auth } from "./auth"
import {
  clayStatus,
  connectClay,
  disconnectClay,
  enrichForRequest as enrichClayForRequest,
  handleClayCallback,
} from "./clay"
import { authorizeCli, exchangeCli } from "./cli-auth"
import { db, pool } from "./db"
import {
  disconnectGoogle,
  getGoogleThread,
  googleStatus,
  handleCalendarPush,
  handleGmailPush,
  handleGoogleCallback,
  handleGoogleConnect,
  listGoogleCalendar,
  listGoogleThreads,
  sendGoogleMail,
  syncGoogleForRequest,
  upsertGoogleCalendarEvent,
} from "./google"
import { attachmentSecurityHeaders } from "./headers"
import { integrationSettingsStatus, updateIntegrationSettings } from "./integrationSettings"
import {
  closeLinearIssueForRequest,
  connectLinear,
  disconnectLinear,
  handleLinearWebhook,
  linearStatus,
  listLinearIssues,
  syncLinearForRequest,
  updateLinearIssueForRequest,
} from "./linear"
import { syncMembershipRole } from "./membership"
import { canConfigure } from "./policy"
import {
  connectPosthog,
  disconnectPosthog,
  handlePosthogWebhook,
  listPosthogPersons,
  posthogStatus,
  syncPosthogForRequest,
} from "./posthog"
import type { UseCaseResult } from "./runtime"
import { resolveOrg, resolveOwner, roleOf, runScoped } from "./session"
import {
  disconnectSlack,
  disconnectSlackUser,
  handleInteractivity,
  handleSlackCallback,
  handleSlackConnect,
  handleSlackEvents,
  handleSlackUserConnect,
  handleSlashCommand,
  listSlackChannels,
  postSlackMessageAsMeForRequest,
  postSlackMessageForRequest,
  slackStatus,
  syncSlackForRequest,
} from "./slack"
import {
  authConfigStatus,
  deleteSsoProvider,
  publicAuthMethods,
  saveSsoProvider,
  updateAuthMethods,
} from "./sso"
import { downloadAttachment, purgeMemberData, uploadAttachment } from "./use-cases"
import { versionInfo } from "./version"

// Security headers are applied centrally in index.ts (`withApiSecurityHeaders`),
// so the many JSON responses below don't each have to remember them. The one
// exception is the attachment route, which sets the STRICTER deny-all profile
// itself and is left alone.
const json = (r: UseCaseResult<unknown>) =>
  Response.json(r.ok ? r.data : { error: r.code, detail: r.detail }, { status: r.status })

/**
 * MIME types that may be served with an `inline` disposition — i.e. rendered by
 * the browser in OUR origin. Deliberately a closed allowlist rather than a
 * blocklist of dangerous types: uploads carry a client-supplied Content-Type, and
 * anything not proven inert here gets `attachment` instead.
 *
 * `image/svg+xml` is NOT here, and that is the point — an SVG is a document that
 * can carry <script>, so inlining one is equivalent to inlining HTML. Same for
 * text/html and anything XML-ish. PDFs stay inline (the viewer is sandboxed and
 * the Files widget previews them), as do plain text, images, audio and video.
 */
const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "application/pdf",
  "text/plain",
])

/** Media whose whole subtree is inert enough to inline (`audio/*`, `video/*`). */
const INLINE_SAFE_PREFIXES = ["audio/", "video/"]

/**
 * May this stored MIME type be rendered inline? Parameters are stripped
 * (uploads arrive as e.g. `text/html;charset=utf-8`, and matching the full
 * string would miss it) and the comparison is lowercased.
 */
export const isInlineSafe = (mimeType: string | null | undefined): boolean => {
  if (!mimeType) return false
  const base = mimeType.split(";")[0]!.trim().toLowerCase()
  if (INLINE_SAFE_TYPES.has(base)) return true
  return INLINE_SAFE_PREFIXES.some((p) => base.startsWith(p))
}

/**
 * The two multipart upload routes, sharing everything but the owner. Content-Length
 * is checked BEFORE `formData()` so an oversized body is refused without buffering
 * it; the engine re-checks the real byte count (this header is client-supplied, and
 * multipart framing inflates it slightly).
 */
const uploadRoute = async (req: Request, owner: UploadOwner): Promise<Response> => {
  const declared = Number(req.headers.get("content-length") ?? 0)
  if (declared > MAX_UPLOAD_BYTES)
    return Response.json(
      {
        error: "ATTACHMENT_TOO_LARGE",
        detail: { sizeBytes: declared, maxBytes: MAX_UPLOAD_BYTES },
      },
      { status: 413 },
    )
  const form = await req.formData().catch(() => null)
  const file = form?.get("file")
  if (!(file instanceof File))
    return Response.json({ error: "file field required" }, { status: 400 })
  // Bun hands back a plain Blob (no `name`) for a zero-byte multipart part, and it
  // still passes `instanceof File` — so an empty file reached the insert with
  // filename undefined, tripping the NOT NULL and surfacing as an opaque 500.
  // Refuse it here: a nameless or empty upload is a client mistake, not a defect.
  if (!file.name) return Response.json({ error: "file name required" }, { status: 400 })
  if (file.size === 0) return Response.json({ error: "file is empty" }, { status: 400 })
  const data = new Uint8Array(await file.arrayBuffer())
  return json(
    await runScoped(req, uploadAttachment(owner, file.name, file.type || undefined, data)),
  )
}

/**
 * Plain-HTTP routes that don't fit JSON-RPC: binary attachment upload/download.
 * Everything else goes through the typed RPC endpoint (`/api/rpc`). Returns null
 * when nothing matches.
 */
/**
 * Does this path belong to BetterAuth's own handler (basePath `/api/auth`)?
 *
 * The boundary is load-bearing. A bare `startsWith("/api/auth")` also swallows
 * `/api/auth-config/*` — our OWN routes — and hands them to BetterAuth, which
 * 404s an unknown path with an empty body. That made the entire Settings →
 * Authentication page dead in the browser while every test stayed green,
 * because the tests call the handlers directly and never cross this dispatch.
 * Any future `/api/auth<something>` route needs the same care.
 */
export const isBetterAuthPath = (pathname: string): boolean =>
  pathname === "/api/auth" || pathname.startsWith("/api/auth/")

export const handleApi = async (req: Request): Promise<Response | null> => {
  const url = new URL(req.url)
  const p = url.pathname
  if (!p.startsWith("/api/")) return null
  const seg = p.split("/").filter(Boolean) // ["api", ...]
  const m = req.method

  // Which build is this, and is a newer one published? Session-gated (any
  // member): the running version is a fingerprint useful to an attacker for
  // matching known CVEs, so it is not public. Advisory only — see version.ts.
  if (seg[1] === "version" && !seg[2] && m === "GET") {
    const org = await resolveOrg(req)
    if (!org.ok) return Response.json({ error: org.code }, { status: org.status })
    return Response.json(versionInfo())
  }

  // Org authentication config: the OIDC provider + the sign-in method toggles.
  // Mounted at /api/auth-config, NOT under /api/auth — that whole prefix is
  // handed to better-auth's own handler in index.ts before this router sees it.
  if (seg[1] === "auth-config") {
    // Unauthenticated by design — the sign-in page needs it before a session
    // exists. Booleans only; see publicAuthMethods.
    if (seg[2] === "public" && !seg[3] && m === "GET") return publicAuthMethods()
    if (seg[2] === "sso" && !seg[3] && m === "GET") return authConfigStatus(req)
    if (seg[2] === "sso" && !seg[3] && m === "POST") return saveSsoProvider(req)
    if (seg[2] === "sso" && !seg[3] && m === "DELETE") return deleteSsoProvider(req)
    if (seg[2] === "methods" && !seg[3] && m === "POST") return updateAuthMethods(req)
  }

  // Browser hand-off for the CLI: the person signs in normally in a browser and
  // the credential comes back to a loopback listener. Deliberately NOT under
  // /api/auth (that whole prefix belongs to BetterAuth's own handler) and
  // deliberately not an RPC — `authorize` has to be a plain GET a browser can
  // follow, and it answers with a redirect.
  if (seg[1] === "cli") {
    if (seg[2] === "authorize" && !seg[3] && m === "GET") return authorizeCli(req)
    if (seg[2] === "exchange" && !seg[3] && m === "POST") return exchangeCli(req)
  }

  // Per-org overrides for the connector toggles. Sibling of the connectors
  // rather than a sub-route of any one of them — the payload covers all six.
  if (seg[1] === "integrations" && seg[2] === "settings" && !seg[3]) {
    if (m === "GET") return integrationSettingsStatus(req)
    if (m === "POST") return updateIntegrationSettings(req)
  }

  if (seg[1] === "integrations" && seg[2] === "google") {
    if (seg[3] === "connect" && m === "GET") return handleGoogleConnect(req)
    if (seg[3] === "callback" && m === "GET") return handleGoogleCallback(req)
    if (seg[3] === "status" && m === "GET") return googleStatus(req)
    if (seg[3] === "disconnect" && m === "POST") return disconnectGoogle(req)
    if (seg[3] === "sync" && m === "POST") return syncGoogleForRequest(req)
    if (seg[3] === "calendar" && seg[4] === "push" && m === "POST") return handleCalendarPush(req)
    if (seg[3] === "calendar" && !seg[4] && m === "GET") return listGoogleCalendar(req)
    if (seg[3] === "calendar" && !seg[4] && m === "POST") return upsertGoogleCalendarEvent(req)
    if (seg[3] === "calendar" && seg[4] && m === "PATCH")
      return upsertGoogleCalendarEvent(req, seg[4])
    if (seg[3] === "gmail" && seg[4] === "push" && m === "POST") return handleGmailPush(req)
    if (seg[3] === "gmail" && seg[4] === "threads" && !seg[5] && m === "GET")
      return listGoogleThreads(req)
    if (seg[3] === "gmail" && seg[4] === "threads" && seg[5] && m === "GET")
      return getGoogleThread(req, seg[5])
    if (seg[3] === "gmail" && seg[4] === "send" && m === "POST") return sendGoogleMail(req)
  }

  if (seg[1] === "integrations" && seg[2] === "analytics") {
    if (seg[3] === "query" && m === "POST") return queryAnalytics(req)
  }

  if (seg[1] === "integrations" && seg[2] === "posthog") {
    if (seg[3] === "connect" && m === "POST") return connectPosthog(req)
    if (seg[3] === "status" && m === "GET") return posthogStatus(req)
    if (seg[3] === "disconnect" && m === "POST") return disconnectPosthog(req)
    if (seg[3] === "sync" && m === "POST") return syncPosthogForRequest(req)
    if (seg[3] === "persons" && m === "GET") return listPosthogPersons(req)
    if (seg[3] === "webhook" && m === "POST") return handlePosthogWebhook(req)
  }

  if (seg[1] === "integrations" && seg[2] === "linear") {
    if (seg[3] === "connect" && m === "POST") return connectLinear(req)
    if (seg[3] === "status" && m === "GET") return linearStatus(req)
    if (seg[3] === "disconnect" && m === "POST") return disconnectLinear(req)
    if (seg[3] === "sync" && m === "POST") return syncLinearForRequest(req)
    if (seg[3] === "webhook" && m === "POST") return handleLinearWebhook(req)
    if (seg[3] === "issues" && !seg[4] && m === "GET") return listLinearIssues(req)
    if (seg[3] === "issues" && seg[4] && seg[5] === "close" && m === "POST")
      return closeLinearIssueForRequest(req, seg[4])
    if (seg[3] === "issues" && seg[4] && !seg[5] && m === "POST")
      return updateLinearIssueForRequest(req, seg[4])
  }

  if (seg[1] === "integrations" && seg[2] === "slack") {
    if (seg[3] === "connect" && m === "GET") return handleSlackConnect(req)
    if (seg[3] === "callback" && m === "GET") return handleSlackCallback(req)
    if (seg[3] === "status" && m === "GET") return slackStatus(req)
    if (seg[3] === "disconnect" && m === "POST") return disconnectSlack(req)
    if (seg[3] === "user" && seg[4] === "connect" && m === "GET") return handleSlackUserConnect(req)
    if (seg[3] === "user" && seg[4] === "disconnect" && m === "POST")
      return disconnectSlackUser(req)
    if (seg[3] === "sync" && m === "POST") return syncSlackForRequest(req)
    if (seg[3] === "channels" && m === "GET") return listSlackChannels(req)
    if (seg[3] === "post" && m === "POST") return postSlackMessageForRequest(req)
    if (seg[3] === "post-as-me" && m === "POST") return postSlackMessageAsMeForRequest(req)
    if (seg[3] === "events" && m === "POST") return handleSlackEvents(req)
    if (seg[3] === "commands" && m === "POST") return handleSlashCommand(req)
    if (seg[3] === "interactivity" && m === "POST") return handleInteractivity(req)
  }

  if (seg[1] === "integrations" && seg[2] === "apollo") {
    if (seg[3] === "connect" && m === "POST") return connectApollo(req)
    if (seg[3] === "status" && m === "GET") return apolloStatus(req)
    if (seg[3] === "disconnect" && m === "POST") return disconnectApollo(req)
    if (seg[3] === "enrich" && m === "POST") return enrichRecordForRequest(req)
    if (seg[3] === "search" && m === "POST") return searchForRequest(req)
    if (seg[3] === "import" && m === "POST") return importForRequest(req)
  }

  if (seg[1] === "integrations" && seg[2] === "clay") {
    if (seg[3] === "connect" && m === "POST") return connectClay(req)
    if (seg[3] === "status" && m === "GET") return clayStatus(req)
    if (seg[3] === "disconnect" && m === "POST") return disconnectClay(req)
    // Push a record version into the Clay table (async round-trip; enriched data
    // returns via the callback below).
    if (seg[3] === "enrich" && m === "POST") return enrichClayForRequest(req)
    // Clay → KM enriched callback. No session: routed by ?cid= and verified by
    // the shared callback secret (see handleClayCallback).
    if (seg[3] === "callback" && m === "POST") return handleClayCallback(req)
  }

  // Multipart upload onto a record, or into a Files widget's own bucket
  // (reads/mutations of the metadata are typed RPCs — listFiles/archiveFile/
  // restoreFile/deleteFile/purgeBucket).
  if (seg[1] === "records" && seg[2] && seg[3] === "attachments" && m === "POST")
    return uploadRoute(req, { recordId: seg[2] })
  if (seg[1] === "buckets" && seg[2] && seg[3] === "attachments" && m === "POST")
    return uploadRoute(req, {
      bucketId: seg[2],
      // Anything but an explicit shared=false means listable at org scope.
      shared: new URL(req.url).searchParams.get("shared") !== "false",
    })

  // Org rename / logo. Ours rather than `authClient.organization.update` — BetterAuth
  // decides that endpoint from the caller's MEMBERSHIP tier, and an administrator is
  // a membership-`member` holding the Admin role now, so it would refuse them.
  // Schema/settings administration, so it stays on blanket org-`configure` (the
  // default `canConfigure` resource) rather than the narrower `member`/`role` gates
  // the two member-roster routes below use.
  if (seg[1] === "org" && !seg[2] && m === "POST") {
    const org = await resolveOrg(req)
    if (!org.ok) return Response.json({ error: org.code }, { status: org.status })
    const role = await roleOf(org.actor, org.orgId)
    if (!(await canConfigure(org.orgId, org.actor, role)))
      return Response.json({ error: "FORBIDDEN" }, { status: 403 })

    const body = (await req.json().catch(() => null)) as {
      name?: string
      logo?: string | null
    } | null
    const name = body?.name?.trim()
    if (name !== undefined && name.length === 0)
      return Response.json({ error: "NAME_REQUIRED" }, { status: 400 })

    const [updated] = await db
      .update(organization)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(body?.logo === undefined ? {} : { logo: body.logo || null }),
      })
      .where(eq(organization.id, org.orgId))
      .returning({ id: organization.id, name: organization.name, logo: organization.logo })
    if (!updated) return Response.json({ error: "NO_SUCH_ORG" }, { status: 404 })
    return Response.json(updated)
  }

  // Team management: add an EXISTING user to the active org by email. No
  // invitation/email flow — the user must already have an account.
  //
  // Gated on `configure` on `member`, not blanket org-configure — this is the
  // member roster, not schema/settings administration, and the two are now
  // separately grantable.
  if (seg[1] === "org" && seg[2] === "members" && !seg[3] && m === "POST") {
    const org = await resolveOrg(req)
    if (!org.ok) return Response.json({ error: org.code }, { status: org.status })
    const role = await roleOf(org.actor, org.orgId)
    if (!(await canConfigure(org.orgId, org.actor, role, { type: "member" })))
      return Response.json({ error: "FORBIDDEN" }, { status: 403 })

    const body = (await req.json().catch(() => null)) as {
      email?: string
      role?: string
    } | null
    const email = body?.email?.trim()
    // Everyone joins as a plain member. Membership carries only the owner flag now;
    // what someone may DO is the access roles they hold, granted after they join.
    if (!email) return Response.json({ error: "EMAIL_REQUIRED" }, { status: 400 })

    // Case-insensitive EXACT match. `ilike` is a pattern match, so `%` and `_` in
    // the request body would be wildcards: `{"email":"%"}` used to match the
    // first user in the table — any user, in any org — and add THEM to this org.
    // Compare lowercased equality instead, which has no pattern semantics at all.
    const [target] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(sql`lower(${user.email})`, email.toLowerCase()))
      .limit(1)
    if (!target) return Response.json({ error: "NO_SUCH_USER" }, { status: 404 })
    if (await roleOf(target.id, org.orgId))
      return Response.json({ error: "ALREADY_MEMBER" }, { status: 409 })

    try {
      // NO `headers`. BetterAuth would otherwise check the CALLER's membership tier,
      // and an administrator is a membership-`member` holding the Admin role now —
      // it would refuse them. Authorization already happened above, on our rules;
      // this call is the write. (`addMember` accepts a headerless "system action";
      // `updateMemberRole` and `removeMember` do not, which is why those two write
      // the table directly.)
      const member = await auth.api.addMember({
        body: { userId: target.id, role: "member", organizationId: org.orgId },
      })
      // `afterAddMember` in auth.ts already synced their access roles — belt and
      // braces for the case where the hook is bypassed by a future BetterAuth change.
      await syncMembershipRole(org.orgId, target.id, "member")
      return Response.json(member, { status: 201 })
    } catch (e) {
      return Response.json({ error: "ADD_FAILED", detail: String(e) }, { status: 500 })
    }
  }

  // ── THE OWNER TOGGLE ───────────────────────────────────────────────────────
  //
  // Membership is `owner | member` and carries nothing else: what someone may DO is
  // the access roles they hold. So this route only makes and unmakes owners.
  //
  // OWNER-ONLY, not configure-gated. Owner is no longer an unconditional bypass
  // (see the Layer 0 floor, `runtime.ts:sessionScope`) but it is still the one
  // membership fact nothing can edit away — handing it out is the most privileged
  // act in the app, and an administrator who holds `configure` on `org` through a
  // role of their own making could otherwise promote themselves past the rules
  // that define them. The same reasoning gates the SSO settings (see `resolveOwner`).
  //
  // The last-owner check is enforced HERE rather than in the UI that draws the menu:
  // a hand-rolled request could otherwise leave an org with no owner and nobody able
  // to restore one.
  if (seg[1] === "org" && seg[2] === "members" && seg[3] && seg[4] === "role" && m === "POST") {
    const org = await resolveOwner(req)
    if (!org.ok) return Response.json({ error: org.code }, { status: org.status })

    const body = (await req.json().catch(() => null)) as { role?: string } | null
    const next = body?.role
    if (next !== "owner" && next !== "member")
      return Response.json({ error: "INVALID_ROLE" }, { status: 400 })

    const userId = seg[3]
    const current = await roleOf(userId, org.orgId)
    if (!current) return Response.json({ error: "NO_SUCH_MEMBER" }, { status: 404 })

    if (current === "owner" && next !== "owner") {
      const owners = await db
        .select({ userId: member.userId })
        .from(member)
        .where(and(eq(member.organizationId, org.orgId), eq(member.role, "owner")))
      if (owners.length <= 1) return Response.json({ error: "LAST_OWNER" }, { status: 409 })
    }

    const [target] = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, org.orgId)))
      .limit(1)
    if (!target) return Response.json({ error: "NO_SUCH_MEMBER" }, { status: 404 })

    try {
      const updated = await auth.api.updateMemberRole({
        body: { memberId: target.id, role: next, organizationId: org.orgId },
        // Headers ARE passed here, unlike addMember: this route is owner-only, so
        // BetterAuth's own tier check is satisfied by the same caller our gate just
        // approved. No bypass needed, and none invented.
        headers: req.headers,
      })
      return Response.json(updated)
    } catch (e) {
      return Response.json({ error: "ROLE_UPDATE_FAILED", detail: String(e) }, { status: 500 })
    }
  }

  // Member purge: permanently remove a DEACTIVATED member from the org —
  // BetterAuth membership first, then the engine's per-member data (page +
  // deactivation marker). Mirrors the archive→purge convention: an active member
  // must be deactivated before they can be deleted. The user account itself is
  // never touched (it may belong to other orgs). Same `member` gate as adding one.
  if (seg[1] === "org" && seg[2] === "members" && seg[3] && m === "DELETE") {
    const org = await resolveOrg(req)
    if (!org.ok) return Response.json({ error: org.code }, { status: org.status })
    const role = await roleOf(org.actor, org.orgId)
    if (!(await canConfigure(org.orgId, org.actor, role, { type: "member" })))
      return Response.json({ error: "FORBIDDEN" }, { status: 403 })

    const userId = seg[3]
    const targetRole = await roleOf(userId, org.orgId)
    if (!targetRole) return Response.json({ error: "NO_SUCH_MEMBER" }, { status: 404 })
    const deactivated = await pool.query(
      "SELECT 1 FROM member_deactivations WHERE org_id = $1 AND user_id = $2 LIMIT 1",
      [org.orgId, userId],
    )
    if (deactivated.rows.length === 0)
      return Response.json({ error: "NOT_DEACTIVATED" }, { status: 409 })

    const [target] = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, org.orgId)))
      .limit(1)
    if (!target) return Response.json({ error: "NO_SUCH_MEMBER" }, { status: 404 })

    try {
      // A DIRECT DELETE, not `auth.api.removeMember`.
      //
      // That API insists on `headers` and then re-decides authorization from the
      // caller's MEMBERSHIP tier — which an administrator no longer has, since Admin
      // is an access role and membership carries only the owner flag. Passing the
      // caller's headers would refuse the very people this route is gated for, and
      // forging a session to satisfy it would be worse than owning the write.
      //
      // Authorization already happened above, against our rules. The row is the only
      // thing BetterAuth is contributing, and `member` has no dependent rows on its
      // side (sessions key on user, not membership). Access-role assignments are
      // cleared by `purgeMemberData` below.
      await db
        .delete(member)
        .where(and(eq(member.userId, userId), eq(member.organizationId, org.orgId)))
    } catch (e) {
      return Response.json({ error: "REMOVE_FAILED", detail: String(e) }, { status: 500 })
    }
    return json(await runScoped(req, purgeMemberData(userId)))
  }

  // Binary download. `?inline=1` serves with an inline disposition so the
  // browser renders previews natively (img/pdf) instead of saving — but ONLY for
  // types that cannot execute; see `inlineDisposition`.
  if (seg[1] === "attachments" && seg[2] && seg[3] === "download" && m === "GET") {
    const result = await runScoped(req, downloadAttachment(seg[2]))
    if (!result.ok)
      return Response.json(
        { error: result.code },
        { status: result.status, headers: attachmentSecurityHeaders() },
      )
    const { attachment, data } = result.data as {
      attachment: { filename: string; mimeType: string | null }
      data: Uint8Array
    }
    const declared = attachment.mimeType
    const inline = url.searchParams.get("inline") !== null && isInlineSafe(declared)
    const safeName = attachment.filename.replace(/["\\\r\n]/g, "_")
    return new Response(data as unknown as BodyInit, {
      headers: {
        ...attachmentSecurityHeaders(),
        // Serve the stored type only when it is inline-safe. Anything else —
        // notably text/html and image/svg+xml — is downgraded to
        // application/octet-stream AND forced to `attachment`, so the browser
        // saves the bytes instead of rendering them in our origin.
        "content-type": inline ? (declared as string) : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      },
    })
  }

  return null
}
