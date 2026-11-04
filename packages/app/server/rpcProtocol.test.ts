import { RPC_PROTOCOL_HEADER, RPC_PROTOCOL_VERSION } from "@kahunalabs/contract"
import { describe, expect, it } from "vitest"
import { rpcHandler } from "./rpc"
import {
  clientRpcProtocol,
  protocolMismatchMessage,
  RPC_PROTOCOL_MISMATCH_STATUS,
} from "./rpcProtocol"

/**
 * The RPC protocol gate, server side: `/api/rpc` refuses another generation
 * BEFORE decoding, and stamps its own on every response.
 */

const HOST = "http://localhost"

/** One ndjson RPC request, encoded the way both generations frame a request. */
const listConcepts = `${JSON.stringify({
  _tag: "Request",
  id: "0",
  tag: "listConcepts",
  payload: {},
  headers: [],
})}\n`

const post = (headers: Record<string, string>) =>
  rpcHandler(
    new Request(`${HOST}/api/rpc`, {
      method: "POST",
      body: listConcepts,
      headers: { "content-type": "application/ndjson", ...headers },
    }),
  )

/** The refusal body is ONE ndjson `Defect` line — the message both generations decode. */
const refusalOf = async (res: Response) => {
  const text = await res.text()
  expect(text.endsWith("\n")).toBe(true)
  const lines = text.trimEnd().split("\n")
  expect(lines).toHaveLength(1)
  const msg = JSON.parse(lines[0]!) as {
    _tag: string
    defect: { name: string; message: string }
  }
  expect(msg._tag).toBe("Defect")
  return msg.defect
}

describe("RPC protocol gate (server side)", () => {
  it("refuses a request with NO protocol header — what every Effect-3 client sends", async () => {
    // Exactly the headers Node's fetch adds for the published CLI: it is not a browser.
    const res = await post({ "sec-fetch-mode": "cors", "user-agent": "node" })
    expect(res.status).toBe(RPC_PROTOCOL_MISMATCH_STATUS)
    expect(res.headers.get(RPC_PROTOCOL_HEADER)).toBe(String(RPC_PROTOCOL_VERSION))
    const defect = await refusalOf(res)
    expect(defect.message).toBe(
      `This server needs a newer kahuna CLI (server speaks RPC protocol ${RPC_PROTOCOL_VERSION}, this CLI speaks 1).\nRun \`kahuna cli update\`.`,
    )
  })

  it("refuses a different generation, in either direction", async () => {
    const older = await post({ [RPC_PROTOCOL_HEADER]: String(RPC_PROTOCOL_VERSION - 1) })
    expect(older.status).toBe(RPC_PROTOCOL_MISMATCH_STATUS)
    expect((await refusalOf(older)).message).toMatch(/^This server needs a newer kahuna CLI/)

    const newer = await post({ [RPC_PROTOCOL_HEADER]: String(RPC_PROTOCOL_VERSION + 1) })
    expect(newer.status).toBe(RPC_PROTOCOL_MISMATCH_STATUS)
    expect(newer.headers.get(RPC_PROTOCOL_HEADER)).toBe(String(RPC_PROTOCOL_VERSION))
    expect((await refusalOf(newer)).message).toMatch(/^This server is older than this kahuna CLI/)
  })

  it("words the refusal for a page when a browser sent it (a stale SPA tab)", async () => {
    const res = await post({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" })
    expect((await refusalOf(res)).message).toMatch(/^This page is out of date .* Reload/)
  })

  it("ACCEPTS the current generation, decodes it, and stamps the response", async () => {
    // No session, so the RPC itself fails — but as a decoded, encoded RPC answer,
    // which proves the request got past the gate and through Effect RPC.
    const res = await post({ [RPC_PROTOCOL_HEADER]: String(RPC_PROTOCOL_VERSION) })
    expect(res.status).toBe(200)
    expect(res.headers.get(RPC_PROTOCOL_HEADER)).toBe(String(RPC_PROTOCOL_VERSION))
    const [exit] = (await res.text())
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as { _tag: string; requestId: string; exit: unknown })
    expect(exit?._tag).toBe("Exit")
    expect(exit?.requestId).toBe("0")
    expect(exit?.exit).toEqual({
      _tag: "Failure",
      cause: [
        {
          _tag: "Fail",
          error: {
            _tag: "RpcError",
            code: "UNAUTHENTICATED",
            message: "Not signed in",
            status: 401,
          },
        },
      ],
    })
  })

  it("reads a garbled header as the header-less first generation", () => {
    const req = (v?: string) =>
      new Request(`${HOST}/api/rpc`, {
        headers: v === undefined ? {} : { [RPC_PROTOCOL_HEADER]: v },
      })
    expect(clientRpcProtocol(req())).toBe(1)
    expect(clientRpcProtocol(req("nope"))).toBe(1)
    expect(clientRpcProtocol(req("0"))).toBe(1)
    expect(clientRpcProtocol(req(String(RPC_PROTOCOL_VERSION)))).toBe(RPC_PROTOCOL_VERSION)
  })

  it("names both generations in every message", () => {
    for (const client of [1, RPC_PROTOCOL_VERSION + 1])
      for (const browser of [false, true])
        expect(protocolMismatchMessage(client, browser)).toContain(
          `server speaks RPC protocol ${RPC_PROTOCOL_VERSION}, this ${browser ? "page" : "CLI"} speaks ${client}`,
        )
  })
})
