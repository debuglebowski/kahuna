import { PgClient } from "@effect/sql-pg"
import { Duration, Effect, Schedule, Stream } from "effect"
import { EVENT_CHANNEL, type EventEnvelope, type SubjectKind } from "#engine"
import { AppRuntime } from "./runtime"
import { resolveOrg } from "./session"

/**
 * In-process SSE fan-out for live/reactive sync.
 *
 * One process-wide LISTEN on the `km_events` channel feeds an org-keyed
 * registry of subscribers. Each appended engine event arrives as a tiny
 * metadata envelope (never field values); the client uses it ONLY to trigger
 * a targeted refetch. Org isolation is enforced HERE — a subscriber is only
 * ever in its own org's set, and `dispatch` fans out by `env.org`.
 */

/** An SSE subscriber; receives envelopes for its own org only. */
interface Client {
  readonly send: (env: EventEnvelope) => void
  readonly close: () => void
}

const clients = new Map<string, Set<Client>>()

const register = (orgId: string, c: Client): void => {
  let set = clients.get(orgId)
  if (!set) {
    set = new Set()
    clients.set(orgId, set)
  }
  set.add(c)
}

const unregister = (orgId: string, c: Client): void => {
  const set = clients.get(orgId)
  if (!set) return
  set.delete(c)
  if (set.size === 0) clients.delete(orgId)
}

/**
 * Server-side taps: handlers that see EVERY org's envelopes.
 *
 * Distinct from `subscribe`, which is per-org because that is the SSE isolation
 * boundary — a browser client must never be able to receive another org's
 * envelopes. A tap is in-process server code (the automation runner) with no
 * client behind it, so it is cross-org by design and must not be modelled as a
 * subscriber to a magic "*" org.
 */
const taps = new Set<(env: EventEnvelope) => void>()

/** Register a cross-org, in-process handler; returns an unregister fn. */
export const tap = (handler: (env: EventEnvelope) => void): (() => void) => {
  taps.add(handler)
  return () => taps.delete(handler)
}

/** Fan an envelope out to its org's subscribers — the org-isolation boundary. Exported for tests. */
export const dispatch = (env: EventEnvelope): void => {
  // Taps first: a slow/throwing tap must not delay or break client delivery.
  for (const t of taps) {
    try {
      t(env)
    } catch {
      // A broken tap is dropped rather than allowed to poison the hub.
      taps.delete(t)
    }
  }
  const set = clients.get(env.org)
  if (!set) return
  for (const c of set) {
    try {
      c.send(env)
    } catch {
      unregister(env.org, c)
    }
  }
}

/**
 * Subscribe a handler to one org's envelopes; returns an unsubscribe fn.
 * The org-isolation contract: the handler only ever sees `env` where
 * `env.org === orgId`. Used by the SSE endpoint and exercised by tests.
 */
export const subscribe = (orgId: string, handler: (env: EventEnvelope) => void): (() => void) => {
  const client: Client = { send: handler, close: () => {} }
  register(orgId, client)
  return () => unregister(orgId, client)
}

const sseFrame = (env: EventEnvelope): string =>
  `id: ${env.id}\nevent: km\ndata: ${JSON.stringify(env)}\n\n`

/** Replay missed events (id > since) for one org; conceptName resolved for instance events. */
const replayEventsSince = (orgId: string, since: number) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const rows = yield* sql<{
      readonly id: number | string
      readonly occurred_at: Date
      readonly subject_kind: string
      readonly subject_id: string
      readonly event_type: string
      readonly actor: string | null
      readonly concept_id: string | null
      readonly concept: string | null
    }>`
      SELECT e.id, e.occurred_at, e.subject_kind, e.subject_id, e.event_type, e.actor,
             c.id AS concept_id, c.name AS concept
      FROM events e
      LEFT JOIN instances i
        ON e.subject_kind = 'instance' AND i.id = e.subject_id AND i.org_id = e.org_id
      LEFT JOIN concepts c ON c.id = i.concept_id AND c.org_id = e.org_id
      WHERE e.org_id = ${orgId} AND e.id > ${since}
      ORDER BY e.id ASC
      LIMIT 1000`
    return rows.map(
      (r): EventEnvelope => ({
        org: orgId,
        id: Number(r.id),
        at: r.occurred_at.getTime(),
        kind: r.subject_kind as SubjectKind,
        subjectId: r.subject_id,
        type: r.event_type,
        conceptId: r.concept_id,
        concept: r.concept,
        actor: r.actor,
      }),
    )
  })

let hubStarted = false

/**
 * Start the single process-wide LISTEN, supervised so it survives DB blips.
 * Idempotent. Called explicitly from index.ts (not at import) so tests can use
 * the hub registry without opening a real connection.
 */
export const startHub = (): void => {
  if (hubStarted) return
  hubStarted = true
  const listen = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql.listen(EVENT_CHANNEL).pipe(
      Stream.runForEach((raw) =>
        Effect.sync(() => {
          try {
            dispatch(JSON.parse(raw) as EventEnvelope)
          } catch {
            // ignore malformed payloads
          }
        }),
      ),
    )
  }).pipe(
    Effect.tapErrorCause((cause) => Effect.logError("km LISTEN fiber error", cause)),
    Effect.retry(
      Schedule.exponential(Duration.seconds(1)).pipe(
        Schedule.union(Schedule.spaced(Duration.seconds(30))),
      ),
    ),
  )
  // `forever` restarts even on a clean stream end (connection closed without error).
  AppRuntime.runFork(Effect.forever(listen))
}

/**
 * Close every open SSE stream (clearing its heartbeat) and drop the registry —
 * called on graceful shutdown so these long-lived responses end and the HTTP
 * server can actually drain. The process-wide LISTEN fiber is torn down
 * separately, by disposing the runtime.
 */
export const closeHub = (): void => {
  hubStarted = false
  // Snapshot each set: `close()` unregisters, mutating the set mid-iteration.
  for (const set of clients.values()) for (const c of [...set]) c.close()
  clients.clear()
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const

/** GET /api/stream — per-org SSE feed of live-sync envelopes (Last-Event-ID resumable). */
export const streamHandler = async (req: Request): Promise<Response> => {
  const org = await resolveOrg(req)
  if (!org.ok) return Response.json({ error: org.code }, { status: org.status })
  const orgId = org.orgId

  const lastHeader = req.headers.get("last-event-id")
  const since = lastHeader != null ? Number(lastHeader) : Number.NaN

  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let client: Client | undefined

  const teardown = () => {
    if (heartbeat) clearInterval(heartbeat)
    if (client) unregister(orgId, client)
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s))
        } catch {
          // controller already closed
        }
      }

      // Register live FIRST and buffer incoming frames until the Last-Event-ID
      // replay is flushed — so a reconnect delivers missed events in order with
      // no gap, and without duplicating anything already replayed.
      let replaying = true
      let maxReplayId = 0
      const buffered: EventEnvelope[] = []
      const send = (env: EventEnvelope) => {
        if (replaying) {
          buffered.push(env)
          return
        }
        if (env.id <= maxReplayId) return // already covered by replay
        write(sseFrame(env))
      }
      client = {
        send,
        close: () => {
          teardown() // clear heartbeat + unregister before ending the response
          try {
            controller.close()
          } catch {
            // already closed
          }
        },
      }
      register(orgId, client)
      write(": connected\n\n")

      if (Number.isFinite(since)) {
        const envs = await AppRuntime.runPromise(replayEventsSince(orgId, since)).catch(
          () => [] as EventEnvelope[],
        )
        for (const env of envs) {
          write(sseFrame(env))
          if (env.id > maxReplayId) maxReplayId = env.id
        }
      }

      replaying = false
      for (const env of buffered) if (env.id > maxReplayId) write(sseFrame(env))
      buffered.length = 0

      heartbeat = setInterval(() => write(": ping\n\n"), 25_000)
    },
    cancel() {
      teardown()
    },
  })

  req.signal?.addEventListener("abort", () => {
    teardown()
    client?.close()
  })

  return new Response(stream, { headers: SSE_HEADERS })
}
