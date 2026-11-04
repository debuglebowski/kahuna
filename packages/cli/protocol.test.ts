import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { RPC_PROTOCOL_HEADER, RPC_PROTOCOL_VERSION } from "@kahunalabs/contract"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CliError, EXIT, toFailure } from "./errors.ts"
import { makeRuntime, protocolMismatch } from "./transport.ts"

/**
 * The protocol gate, from the CLI's side: a server a generation away cannot be
 * understood, so the CLI must say WHICH side to update instead of printing an
 * undecodable error. One local HTTP server plays each kind of deployment.
 */

interface Reply {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

let reply: Reply
let lastRequest: IncomingHttpHeaders | undefined
let lastPath: string | undefined
let server: Server
let host: string

beforeAll(async () => {
  server = createServer((req, res) => {
    lastRequest = req.headers
    lastPath = req.url
    req.resume()
    req.on("end", () => {
      res.writeHead(reply.status, reply.headers)
      res.end(reply.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const callOnce = async (): Promise<unknown> => {
  const api = makeRuntime({ host, cookie: "session=x" })
  try {
    return await api.call((c) => c.listConcepts({}))
  } finally {
    await api.dispose()
  }
}

const failureOf = async () => {
  const error = await callOnce().then(
    () => expect.unreachable("the call should have been refused"),
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(CliError)
  return toFailure(error)
}

describe("RPC protocol gate (CLI side)", () => {
  it("sends its protocol generation on every request, to exactly /api/rpc", async () => {
    reply = {
      status: 400,
      headers: { [RPC_PROTOCOL_HEADER]: String(RPC_PROTOCOL_VERSION + 1) },
      body: "",
    }
    await callOnce().catch(() => undefined)
    expect(lastRequest?.[RPC_PROTOCOL_HEADER]).toBe(String(RPC_PROTOCOL_VERSION))
    // Not `/api/rpc/`: Effect 4 would append that slash to a protocol `url`, and no
    // server — old or new — routes it.
    expect(lastPath).toBe("/api/rpc")
  })

  it("a NEWER server's refusal says to update the CLI", async () => {
    const server = RPC_PROTOCOL_VERSION + 1
    reply = {
      status: 400,
      headers: { "content-type": "application/ndjson", [RPC_PROTOCOL_HEADER]: String(server) },
      body: `${JSON.stringify({ _tag: "Defect", defect: { name: "RpcProtocolMismatch", message: "x" } })}\n`,
    }
    expect(await failureOf()).toEqual({
      message: `This server needs a newer kahuna CLI (server speaks RPC protocol ${server}, this CLI speaks ${RPC_PROTOCOL_VERSION}).`,
      hint: "Run `kahuna cli update`.",
      exitCode: EXIT.failed,
    })
  })

  it("an OLD server (no header, Effect-3-shaped error) says the server is older", async () => {
    // Exactly what a 0.0.13–0.0.15 deployment answers an unauthenticated call with.
    reply = {
      status: 200,
      headers: { "content-type": "application/ndjson" },
      body: `${JSON.stringify({
        _tag: "Exit",
        requestId: "0",
        exit: {
          _tag: "Failure",
          cause: {
            _tag: "Fail",
            error: {
              _tag: "RpcError",
              code: "UNAUTHENTICATED",
              message: "Not signed in",
              status: 401,
            },
          },
        },
      })}\n`,
    }
    const failure = await failureOf()
    expect(failure.message).toBe(
      `This server is older than this kahuna CLI (server speaks RPC protocol 1, this CLI speaks ${RPC_PROTOCOL_VERSION}).`,
    )
    expect(failure.hint).toMatch(/Upgrade the server, or install the CLI release that matches it/)
    expect(failure.exitCode).not.toBe(EXIT.ok)
  })

  it("an older server that DOES send the header is older too", () => {
    expect(protocolMismatch({ status: 400, header: "1" })?.message).toMatch(
      /^This server is older than this kahuna CLI/,
    )
  })

  it("passes a matching server and non-RPC responses through to the normal error path", () => {
    expect(protocolMismatch({ status: 200, header: String(RPC_PROTOCOL_VERSION) })).toBeNull()
    // A proxy's 502 carries no header and is not a Kahuna answer at all.
    expect(protocolMismatch({ status: 502, header: null })).toBeNull()
    expect(protocolMismatch({ status: 400, header: "garbled" })).toBeNull()
  })
})
