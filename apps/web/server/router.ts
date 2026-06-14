import { and, eq, ilike } from "drizzle-orm"
import {
  apolloStatus,
  connectApollo,
  disconnectApollo,
  enrichInstanceForRequest,
  importForRequest,
  searchForRequest,
} from "./apollo"
import { auth } from "./auth"
import { member, user } from "./auth-schema"
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
import { resolveOrg, roleOf, runScoped } from "./session"
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

const json = (r: UseCaseResult<unknown>) =>
  Response.json(r.ok ? r.data : { error: r.code, detail: r.detail }, { status: r.status })

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

  // Multipart upload of a file onto an item lineage (reads/mutations of the
  // metadata are typed RPCs — listFiles/archiveFile/restoreFile/deleteFile).
  if (seg[1] === "items" && seg[2] && seg[3] === "attachments" && m === "POST") {
    const form = await req.formData().catch(() => null)
    const file = form?.get("file")
    if (!(file instanceof File))
      return Response.json({ error: "file field required" }, { status: 400 })
    const data = new Uint8Array(await file.arrayBuffer())
    return json(
      await runScoped(req, uploadAttachment(seg[2], file.name, file.type || undefined, data)),
    )
  }

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

    const [target] = await db
      .select({ id: user.id })
      .from(user)
      .where(ilike(user.email, email)) // case-insensitive exact match (no wildcards in email)
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
  // browser renders previews natively (img/pdf) instead of saving.
  if (seg[1] === "attachments" && seg[2] && seg[3] === "download" && m === "GET") {
    const result = await runScoped(req, downloadAttachment(seg[2]))
    if (!result.ok) return Response.json({ error: result.code }, { status: result.status })
    const { attachment, data } = result.data as {
      attachment: { filename: string; mimeType: string | null }
      data: Uint8Array
    }
    const disposition = url.searchParams.get("inline") ? "inline" : "attachment"
    const safeName = attachment.filename.replace(/["\\\r\n]/g, "_")
    return new Response(data as unknown as BodyInit, {
      headers: {
        "content-type": attachment.mimeType ?? "application/octet-stream",
        "content-disposition": `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      },
    })
  }

  return null
}
