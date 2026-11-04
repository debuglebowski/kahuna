import {
  KahunaRpcs,
  layerRpcProtocolHttp,
  RPC_PROTOCOL_HEADER,
  RPC_PROTOCOL_VERSION,
} from "@kahunalabs/contract"
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
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
  // KAHUNA_TOKEN is read here so CI can pass a credential without a config file.
  // Bearer support is stubbed deliberately: the API-key plugin is not installed
  // server-side yet (`auth token create` is a later phase), so a token today
  // would be silently ignored. Fail loudly instead of pretending.
  if (process.env.KAHUNA_TOKEN) {
    throw new CliError(
      "KAHUNA_TOKEN is set, but this deployment has no API-key support yet.",
      EXIT.usage,
      "Use `kahuna auth login` for now; token credentials arrive with `kahuna auth token create`.",
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

/** What one `/api/rpc` response said about the server's protocol generation. */
export interface ObservedProtocol {
  readonly status: number
  /** The `RPC_PROTOCOL_HEADER` value, or null when the server sent none. */
  readonly header: string | null
}

/** Aborts a call whose response came from another protocol generation; never shown. */
const PROTOCOL_ABORT = "kahuna/cli: RPC protocol mismatch"

const PROTOCOL_UPDATE_HINT = "Run `kahuna cli update`."
const PROTOCOL_OLDER_HINT =
  "Upgrade the server, or install the CLI release that matches it (`kahuna system version` shows which version the server runs)."

/**
 * The protocol verdict on a response: null when the server speaks this CLI's
 * generation, or when the response is not a Kahuna RPC answer at all (a proxy's
 * 502 has no header either) — that is left to the ordinary error path.
 *
 * Either mismatch makes every error the server sends undecodable, so it has to be
 * caught HERE, ahead of the call's own outcome:
 *  - header higher than ours: a newer server refused us before decoding;
 *  - header lower, or absent on a 2xx: an older server — one from before the
 *    header existed answers 200 with Effect-3-shaped messages and never sets it.
 */
export const protocolMismatch = (observed: ObservedProtocol): CliError | null => {
  if (observed.header === String(RPC_PROTOCOL_VERSION)) return null
  const ok = observed.status >= 200 && observed.status < 300
  const server = observed.header === null ? (ok ? 1 : Number.NaN) : Number(observed.header)
  if (!Number.isInteger(server)) return null
  const versions = `server speaks RPC protocol ${server}, this CLI speaks ${RPC_PROTOCOL_VERSION}`
  return server > RPC_PROTOCOL_VERSION
    ? new CliError(
        `This server needs a newer kahuna CLI (${versions}).`,
        EXIT.failed,
        PROTOCOL_UPDATE_HINT,
      )
    : new CliError(
        `This server is older than this kahuna CLI (${versions}).`,
        EXIT.failed,
        PROTOCOL_OLDER_HINT,
      )
}

export const makeRuntime = (session: Session) => {
  const headers = authHeaders(session)

  // The latest response's protocol header. A generation is a property of the
  // server, not of one call, so the most recent response speaks for all of them.
  let observed: ObservedProtocol | undefined

  const protocol = layerRpcProtocolHttp({
    url: `${session.host}/api/rpc`,
    transformClient: (client) =>
      HttpClient.tap(
        HttpClient.mapRequest(client, HttpClientRequest.setHeaders(headers)),
        (response) => {
          observed = {
            status: response.status,
            header: response.headers[RPC_PROTOCOL_HEADER] ?? null,
          }
          // Stop BEFORE the body is read. An old server's reply does not merely fail
          // to decode: it echoes request ids in a form this client never matches, so
          // the call would wait forever. `call` turns this into the real message.
          return protocolMismatch(observed) ? Effect.die(PROTOCOL_ABORT) : Effect.void
        },
      ),
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(RpcSerialization.layerNdjson))

  const make = RpcClient.make(KahunaRpcs)
  type Client = Effect.Success<typeof make>
  class ApiClient extends Context.Service<ApiClient, Client>()("kahuna/cli/ApiClient") {}

  const runtime = ManagedRuntime.make(Layer.effect(ApiClient, make).pipe(Layer.provide(protocol)))

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
     * rest of the CLI sees the error the server actually sent — unless the
     * server speaks another protocol generation, in which case nothing it sent
     * can be trusted to decode, and saying which side to update is the answer.
     */
    call: async <A, E>(f: (client: Client) => Effect.Effect<A, E>): Promise<A> => {
      const exit = await runtime.runPromiseExit(Effect.flatMap(ApiClient, f))
      const mismatch = observed ? protocolMismatch(observed) : null
      if (mismatch) throw mismatch
      return unwrapExit(exit)
    },
    dispose: () => runtime.dispose(),
  }
}

export type Api = ReturnType<typeof makeRuntime>
