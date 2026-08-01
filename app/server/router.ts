import { and, eq, sql } from "drizzle-orm"
import { member, user } from "#db"
import { MAX_UPLOAD_BYTES, type UploadOwner } from "#engine"
import { queryAnalytics } from "./analytics"
import {
  apolloStatus,
  connectApollo,
  disconnectApollo,
  enrichInstanceForRequest,
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
import { appSecurityHeaders, attachmentSecurityHeaders } from "./headers"
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
import { can } from "./policy"
import {
  connectPosthog,
  disconnectPosthog,
  handlePosthogWebhook,
  listPosthogPersons,
  posthogStatus,
  syncPosthogForRequest,
} from "./posthog"
import type { UseCaseResult } from "./runtime"
import { resolveAdmin, resolveOrg, roleOf, runScoped } from "./session"
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
    if (seg[3] === "enrich" && m === "POST") return enrichInstanceForRequest(req)
    if (seg[3] === "search" && m === "POST") return searchForRequest(req)
    if (seg[3] === "import" && m === "POST") return importForRequest(req)
  }

  if (seg[1] === "integrations" && seg[2] === "clay") {
    if (seg[3] === "connect" && m === "POST") return connectClay(req)
    if (seg[3] === "status" && m === "GET") return clayStatus(req)
    if (seg[3] === "disconnect" && m === "POST") return disconnectClay(req)
    // Push an instance into the Clay table (async round-trip; enriched data
    // returns via the callback below).
    if (seg[3] === "enrich" && m === "POST") return enrichClayForRequest(req)
    // Clay → KM enriched callback. No session: routed by ?cid= and verified by
    // the shared callback secret (see handleClayCallback).
    if (seg[3] === "callback" && m === "POST") return handleClayCallback(req)
  }

  // Multipart upload onto an item lineage, or into a Files widget's own bucket
  // (reads/mutations of the metadata are typed RPCs — listFiles/archiveFile/
  // restoreFile/deleteFile/purgeBucket).
  if (seg[1] === "items" && seg[2] && seg[3] === "attachments" && m === "POST")
    return uploadRoute(req, { itemId: seg[2] })
  if (seg[1] === "buckets" && seg[2] && seg[3] === "attachments" && m === "POST")
    return uploadRoute(req, {
      bucketId: seg[2],
      // Anything but an explicit shared=false means listable at org scope.
      shared: new URL(req.url).searchParams.get("shared") !== "false",
    })

  // Team management (admin-only): add an EXISTING user to the active org by email.
  // No invitation/email flow — the user must already have an account.
  if (seg[1] === "org" && seg[2] === "members" && !seg[3] && m === "POST") {
    const org = await resolveOrg(req)
    if (!org.ok) return Response.json({ error: org.code }, { status: org.status })
    const role = await roleOf(org.actor, org.orgId)
    if (!role || !can(role, "admin")) return Response.json({ error: "FORBIDDEN" }, { status: 403 })

    const body = (await req.json().catch(() => null)) as {
      email?: string
      role?: string
    } | null
    const email = body?.email?.trim()
    const memberRole = body?.role === "admin" ? "admin" : "member"
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
      const member = await auth.api.addMember({
        body: { userId: target.id, role: memberRole, organizationId: org.orgId },
        headers: req.headers,
      })
      return Response.json(member, { status: 201 })
    } catch (e) {
      return Response.json({ error: "ADD_FAILED", detail: String(e) }, { status: 500 })
    }
  }

  // Role change (admin-only). The client used to call BetterAuth's
  // updateMemberRole directly, which meant the "can't demote the last owner"
  // rule existed only in the UI that drew the menu — a hand-rolled request could
  // leave an org with no owner and nobody able to restore one. Enforce it here.
  if (seg[1] === "org" && seg[2] === "members" && seg[3] && seg[4] === "role" && m === "POST") {
    const org = await resolveAdmin(req)
    if (!org.ok) return Response.json({ error: org.code }, { status: org.status })

    const body = (await req.json().catch(() => null)) as { role?: string } | null
    const next = body?.role
    if (next !== "owner" && next !== "admin" && next !== "member")
      return Response.json({ error: "INVALID_ROLE" }, { status: 400 })

    const userId = seg[3]
    const current = await roleOf(userId, org.orgId)
    if (!current) return Response.json({ error: "NO_SUCH_MEMBER" }, { status: 404 })

    // Demoting the last owner would strip the org of the only role that can
    // administer it. Counted server-side, not trusted from the caller.
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
        headers: req.headers,
      })
      return Response.json(updated)
    } catch (e) {
      return Response.json({ error: "ROLE_UPDATE_FAILED", detail: String(e) }, { status: 500 })
    }
  }

  // Member purge (admin-only): permanently remove a DEACTIVATED member from the
  // org — BetterAuth membership first, then the engine's per-member data (page +
  // deactivation marker). Mirrors the archive→purge convention: an active member
  // must be deactivated before they can be deleted. The user account itself is
  // never touched (it may belong to other orgs).
  if (seg[1] === "org" && seg[2] === "members" && seg[3] && m === "DELETE") {
    const org = await resolveOrg(req)
    if (!org.ok) return Response.json({ error: org.code }, { status: org.status })
    const role = await roleOf(org.actor, org.orgId)
    if (!role || !can(role, "admin")) return Response.json({ error: "FORBIDDEN" }, { status: 403 })

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
      await auth.api.removeMember({
        body: { memberIdOrEmail: target.id, organizationId: org.orgId },
        headers: req.headers,
      })
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
