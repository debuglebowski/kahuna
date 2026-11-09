import { randomUUID } from "node:crypto"
import { KahunaRpcs, layerRpcProtocolHttp } from "@kahunalabs/contract"
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { auth } from "./auth"
import { createUserDirect } from "./provision"
import { rpcHandler } from "./rpc"

/**
 * TEST SUPPORT — the real typed RPC client (`RpcClient.make(KahunaRpcs)`, what the
 * CLI and SPA build) with `fetch` routed in-process into the server's handler.
 * Tests that go through it exercise the WIRE: payload encoding, decoding and the
 * handler — the layer a stubbed transport cannot see.
 */

export const PASSWORD = "password12345"
export const HOST = "http://localhost:3100"

export const signUp = async () => {
  const email = `t-${randomUUID()}@test.dev`
  const created = await createUserDirect({ email, password: PASSWORD, name: "Tester" })
  return { email, userId: created.userId }
}

export const cookieFor = async (email: string): Promise<string> => {
  const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true })
  return (res.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ")
}

/** An in-process RPC client: the CLI's transport, with `fetch` routed straight
 *  into the server's handler instead of over the network. */
export const rpcAs = (cookie: string) => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
    rpcHandler(new Request(input, init))) as typeof fetch
  const protocol = layerRpcProtocolHttp({
    url: `${HOST}/api/rpc`,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders({ cookie, origin: HOST })),
  }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
    Layer.provide(RpcSerialization.layerNdjson),
  )
  const make = RpcClient.make(KahunaRpcs)
  type Client = Effect.Success<typeof make>
  class Api extends Context.Service<Api, Client>()("test/Api") {}
  const runtime = ManagedRuntime.make(Layer.effect(Api, make).pipe(Layer.provide(protocol)))
  return {
    call: async <A, E>(f: (c: Client) => Effect.Effect<A, E>): Promise<A> => {
      const exit = await runtime.runPromiseExit(Effect.flatMap(Api, f))
      if (Exit.isSuccess(exit)) return exit.value
      throw Cause.squash(exit.cause)
    },
    dispose: () => runtime.dispose(),
  }
}
