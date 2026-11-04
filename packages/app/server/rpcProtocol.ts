import { RPC_PROTOCOL_HEADER, RPC_PROTOCOL_VERSION } from "@kahunalabs/contract"

/**
 * The RPC protocol gate: `/api/rpc` refuses a request whose protocol generation
 * is not this server's, BEFORE any Effect RPC decoding, and stamps its own
 * generation on every response.
 *
 * Why it exists: Effect 4 changed how an RPC failure is encoded, so a client and a
 * server a generation apart cannot read each other's errors — every refusal
 * (not signed in, forbidden, not found …) would surface as an undecodable blob.
 * Refusing up front turns that into one clear "update X" message.
 *
 * ── what an OLD (v1, Effect 3) client does with the refusal ──────────────────
 *
 * Its HTTP transport ignores the status code and parses the body as ndjson RPC
 * messages. The one message both generations encode identically is a top-level
 * `Defect` — `{ _tag: "Defect", defect: { name, message } }` — which the v1 client
 * fails the call with, as an `Error` carrying `message`. The published CLI then
 * prints `kahuna <command>: <message>`, so the message IS the user-facing text,
 * and its second line lands on a line of its own. A stale browser tab (an old SPA
 * bundle) gets the same treatment with wording for a page instead of a CLI.
 *
 * ── and a NEW client ─────────────────────────────────────────────────────────
 *
 * It reads `RPC_PROTOCOL_HEADER` off the response — present on a refusal and on
 * every accepted call — so it can tell "server newer" from "server older", and an
 * old server, which never sends the header, from both.
 */

/** Status for a refusal. The v1 transport ignores it; it is for logs and new clients. */
export const RPC_PROTOCOL_MISMATCH_STATUS = 400

/** What a client sent: its generation, or 1 for no/garbled header (v1 sent none). */
export const clientRpcProtocol = (request: Request): number => {
  const sent = request.headers.get(RPC_PROTOCOL_HEADER)
  if (sent === null) return 1
  const n = Number(sent)
  return Number.isInteger(n) && n > 0 ? n : 1
}

/** A browser sends `sec-fetch-site` on every fetch. Not `sec-fetch-mode`: Node's own
 *  fetch (undici, what the CLI runs on) sets that one too. */
const fromBrowser = (request: Request): boolean => request.headers.has("sec-fetch-site")

export const protocolMismatchMessage = (client: number, browser: boolean): string => {
  const versions = `server speaks RPC protocol ${RPC_PROTOCOL_VERSION}, this ${browser ? "page" : "CLI"} speaks ${client}`
  if (client > RPC_PROTOCOL_VERSION)
    return browser
      ? `This page is newer than the server (${versions}). Reload once the server has been updated.`
      : `This server is older than this kahuna CLI (${versions}).\nUpgrade the server, or install the CLI release that matches it.`
  return browser
    ? `This page is out of date (${versions}). Reload to get the current version.`
    : `This server needs a newer kahuna CLI (${versions}).\nRun \`kahuna cli update\`.`
}

/** `response` with this server's generation stamped on it. */
export const stampRpcProtocol = (response: Response): Response => {
  const headers = new Headers(response.headers)
  headers.set(RPC_PROTOCOL_HEADER, String(RPC_PROTOCOL_VERSION))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Null when the request speaks this server's generation; otherwise the refusal
 * to send instead of decoding it.
 */
export const rpcProtocolRefusal = (request: Request): Response | null => {
  const client = clientRpcProtocol(request)
  if (client === RPC_PROTOCOL_VERSION) return null
  const message = protocolMismatchMessage(client, fromBrowser(request))
  // Newline-terminated: an ndjson parser only emits a line once it has seen its end.
  const body = `${JSON.stringify({ _tag: "Defect", defect: { name: "RpcProtocolMismatch", message } })}\n`
  return stampRpcProtocol(
    new Response(body, {
      status: RPC_PROTOCOL_MISMATCH_STATUS,
      headers: { "content-type": "application/ndjson" },
    }),
  )
}
