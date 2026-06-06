import { auth } from "./auth"
import type { UseCaseResult } from "./runtime"
import { seedKingsmaker } from "./seed/seed"
import { roleOf, runScoped } from "./session"
import {
  createArtifact,
  createContact,
  createDeal,
  createInstance,
  createTask,
  downloadAttachment,
  getAccountHub,
  getChanged,
  getDemand,
  getInstance,
  getOwed,
  linkRelation,
  listAttachments,
  listConcepts,
  listInstances,
  logInteraction,
  logSignal,
  transitionInstance,
  updateInstance,
  uploadAttachment,
} from "./use-cases"

const json = (r: UseCaseResult<unknown>) =>
  Response.json(r.ok ? r.data : { error: r.code, detail: r.detail }, { status: r.status })

// biome-ignore lint/suspicious/noExplicitAny: request bodies are dynamic glue.
const readBody = async (req: Request): Promise<any> => {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

/** Dispatch non-auth `/api/*` routes. Returns null when nothing matches. */
export const handleApi = async (req: Request): Promise<Response | null> => {
  const url = new URL(req.url)
  const p = url.pathname
  if (!p.startsWith("/api/")) return null
  const seg = p.split("/").filter(Boolean) // ["api", ...]
  const m = req.method

  if (p === "/api/me" && m === "GET") {
    const session = await auth.api.getSession({ headers: req.headers })
    if (!session?.user) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 })
    const orgId = session.session.activeOrganizationId ?? null
    const role = orgId ? await roleOf(session.user.id, orgId) : null
    return Response.json({
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      orgId,
      role,
    })
  }

  if (p === "/api/bootstrap" && m === "POST") return json(await runScoped(req, seedKingsmaker))
  if (p === "/api/concepts" && m === "GET") return json(await runScoped(req, listConcepts))
  if (p === "/api/owed" && m === "GET") return json(await runScoped(req, getOwed))
  if (p === "/api/changed" && m === "GET") return json(await runScoped(req, getChanged))
  if (p === "/api/demand" && m === "GET") return json(await runScoped(req, getDemand))

  if (p === "/api/relations" && m === "POST") {
    const b = await readBody(req)
    return json(await runScoped(req, linkRelation(b.relationType, b.fromId, b.toId, b.properties)))
  }

  // /api/accounts ...
  if (seg[1] === "accounts") {
    const id = seg[2]
    if (!id && m === "GET")
      return json(
        await runScoped(req, listInstances("Account", { orderBy: { field: "name", dir: "asc" } })),
      )
    if (!id && m === "POST") {
      const b = await readBody(req)
      return json(await runScoped(req, createInstance("Account", b.fields ?? {})))
    }
    if (id && !seg[3] && m === "GET") return json(await runScoped(req, getAccountHub(id)))
    if (id && m === "POST") {
      const b = await readBody(req)
      const fields = b.fields ?? {}
      switch (seg[3]) {
        case "contacts":
          return json(await runScoped(req, createContact(id, fields)))
        case "deals":
          return json(await runScoped(req, createDeal(id, fields)))
        case "signals":
          return json(await runScoped(req, logSignal(id, fields)))
        case "tasks":
          return json(await runScoped(req, createTask(id, fields)))
        case "artifacts":
          return json(await runScoped(req, createArtifact(id, fields)))
        case "interactions":
          return json(await runScoped(req, logInteraction(id, fields, b.contactId)))
      }
    }
  }

  // /api/attachments/:id/download (binary)
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

  // /api/instances/:id/attachments (multipart upload + list)
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

  // /api/instances ...
  if (seg[1] === "instances") {
    const id = seg[2]
    const decorate = url.searchParams.get("decorate") === "1"
    if (!id && m === "GET") {
      const concept = url.searchParams.get("concept")
      if (!concept) return Response.json({ error: "concept required" }, { status: 400 })
      return json(await runScoped(req, listInstances(concept, { decorate })))
    }
    if (!id && m === "POST") {
      const b = await readBody(req)
      return json(await runScoped(req, createInstance(b.conceptName, b.fields ?? {})))
    }
    if (id && !seg[3] && m === "GET") return json(await runScoped(req, getInstance(id, decorate)))
    if (id && !seg[3] && m === "POST") {
      const b = await readBody(req)
      return json(await runScoped(req, updateInstance(id, b.expectedVersion, b.patch ?? {})))
    }
    if (id && seg[3] === "transition" && m === "POST") {
      const b = await readBody(req)
      return json(await runScoped(req, transitionInstance(id, b.expectedVersion, b.field, b.to)))
    }
  }

  return null
}
