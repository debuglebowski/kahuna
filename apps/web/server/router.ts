import { and, eq, ilike } from "drizzle-orm"
import { auth } from "./auth"
import { member, user } from "./auth-schema"
import { db, pool } from "./db"
import { can } from "./policy"
import type { UseCaseResult } from "./runtime"
import { resolveOrg, roleOf, runScoped } from "./session"
import { downloadAttachment, listAttachments, purgeMemberData, uploadAttachment } from "./use-cases"

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

  // Multipart upload + list of an instance's attachments.
  if (seg[1] === "instances" && seg[2] && seg[3] === "attachments") {
    if (m === "GET") return json(await runScoped(req, listAttachments(seg[2])))
    if (m === "POST") {
      const form = await req.formData().catch(() => null)
      const file = form?.get("file")
      if (!(file instanceof File))
        return Response.json({ error: "file field required" }, { status: 400 })
      const data = new Uint8Array(await file.arrayBuffer())
      return json(
        await runScoped(req, uploadAttachment(seg[2], file.name, file.type || undefined, data)),
      )
    }
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

  // Binary download.
  if (seg[1] === "attachments" && seg[2] && seg[3] === "download" && m === "GET") {
    const result = await runScoped(req, downloadAttachment(seg[2]))
    if (!result.ok) return Response.json({ error: result.code }, { status: result.status })
    const { attachment, data } = result.data as {
      attachment: { filename: string; mimeType: string | null }
      data: Uint8Array
    }
    return new Response(data as unknown as BodyInit, {
      headers: {
        "content-type": attachment.mimeType ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${attachment.filename}"`,
      },
    })
  }

  return null
}
