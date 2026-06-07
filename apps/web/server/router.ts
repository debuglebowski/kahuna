import type { UseCaseResult } from "./runtime"
import { runScoped } from "./session"
import { downloadAttachment, listAttachments, uploadAttachment } from "./use-cases"

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
