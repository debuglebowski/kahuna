import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { KingsmakerRpcs } from "@kingsmaker/contract"
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from "effect"
import type { Session } from "./config.ts"
import { CliError, EXIT } from "./errors.ts"

/**
 * The typed RPC client, pointed at a deployment and carrying a credential.
 *
 * Same contract the server implements and the SPA calls, which is the whole
 * anti-drift guarantee: a procedure that changes shape fails to compile here,
 * not at runtime in front of a user.
 *
 * The SPA builds this once at module scope against a relative `/api/rpc` and
 * lets the browser attach cookies. A CLI has neither — the host is only known
 * once flags and config have been read, and nothing attaches credentials for
 * us — so the client is built per invocation and the cookie is injected through
 * `transformClient`.
 */
const authHeaders = (session: Session): Record<string, string> => {
  // KM_TOKEN is read here so CI can pass a credential without a config file.
  // Bearer support is stubbed deliberately: the API-key plugin is not installed
  // server-side yet (`auth token create` is a later phase), so a token today
  // would be silently ignored. Fail loudly instead of pretending.
  if (process.env.KM_TOKEN) {
    throw new CliError(
      "KM_TOKEN is set, but this deployment has no API-key support yet.",
      EXIT.usage,
      "Use `km auth login` for now; token credentials arrive with `km auth token create`.",
    )
  }
  // `origin` for the same reason rest.ts sends it: anything that reaches
  // BetterAuth without one is refused, and Node's fetch adds none.
  return { cookie: session.cookie, origin: session.host }
}

/**
 * Take the value out of an Exit, or throw the error the SERVER sent.
 *
 * Exported for its test: this is one line whose absence is invisible in every
 * happy path and wrong in every failing one.
 */
export const unwrapExit = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

export const makeRuntime = (session: Session) => {
  const headers = authHeaders(session)

  const protocol = RpcClient.layerProtocolHttp({
    url: `${session.host}/api/rpc`,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)),
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(RpcSerialization.layerNdjson))

  const make = RpcClient.make(KingsmakerRpcs)
  type Client = Effect.Effect.Success<typeof make>
  class ApiClient extends Context.Tag("kingsmaker/cli/ApiClient")<ApiClient, Client>() {}

  const runtime = ManagedRuntime.make(Layer.scoped(ApiClient, make).pipe(Layer.provide(protocol)))

  return {
    /**
     * Run one procedure and hand back a plain promise.
     *
     * `runPromise` rejects with a `FiberFailureImpl` — an Effect wrapper whose
     * only own properties are `name` and `stack`. The server's `RpcError`, with
     * the `code` and `status` every exit code is derived from, is buried in the
     * Cause. Left wrapped, every failure exits 1 and prints Effect's message
     * instead of ours, which is exactly what happened the first time this ran.
     *
     * So unwrap here, once, at the only boundary that knows about Effect: the
     * rest of the CLI sees the error the server actually sent.
     */
    call: async <A, E>(f: (client: Client) => Effect.Effect<A, E>): Promise<A> =>
      unwrapExit(await runtime.runPromiseExit(Effect.flatMap(ApiClient, f))),
    dispose: () => runtime.dispose(),
  }
}

export type Api = ReturnType<typeof makeRuntime>
