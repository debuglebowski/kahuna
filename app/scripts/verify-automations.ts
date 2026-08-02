/**
 * End-to-end verification of automations against a RUNNING server.
 *
 * Drives the real RPCs the browser calls, through the same Effect client
 * `src/lib/api.ts` builds — so this exercises the whole path a green unit suite
 * cannot: the `pg_notify` → hub tap → trigger match → run claim → action →
 * `AutomationRan` chain, in-process, on a real database.
 *
 * The five things it is actually here to prove:
 *   1. An enabled rule FIRES on a real record edit (the runner is wired at all).
 *   2. `changedTo` distinguishes a transition from a resting value.
 *   3. The ONE-HOP guard holds: an automation's own write does not trigger a
 *      second automation.
 *   4. A disabled rule stays silent.
 *   5. Non-matching conditions record a `skipped` run rather than vanishing.
 *
 * Defaults to the throwaway stack (API :3199) so a run can't disturb the
 * slay-managed one; point API/ORIGIN at :3100/:5100 to verify the managed stack.
 */
import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { KingsmakerRpcs } from "../rpc/contract"
import { provisionVerifyIdentity } from "./verify-session"

const API = process.env.API ?? "http://localhost:3199"
const ORIGIN = process.env.ORIGIN ?? "http://localhost:5199"
let cookie = ""

const req = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}), origin: ORIGIN },
  })
  const setC = res.headers.getSetCookie?.() ?? []
  if (setC.length) cookie = setC.map((c) => c.split(";")[0]).join("; ")
  return res
}

let failures = 0
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`)
  if (!cond) failures++
}

/** The runner is async by design (it runs AFTER the commit), so every assertion
 *  about a run has to wait for it. Polls instead of sleeping a flat interval. */
const until = async <T>(
  what: () => Promise<T>,
  pred: (v: T) => boolean,
  { tries = 25, gap = 200 } = {},
): Promise<T> => {
  let last = await what()
  for (let i = 0; i < tries && !pred(last); i++) {
    await new Promise((r) => setTimeout(r, gap))
    last = await what()
  }
  return last
}

// ── session ──
// Provisioned in-process: sign-up and member org-creation are both closed
// server-side (see server/auth.ts + scripts/verify-session.ts).
const identity = await provisionVerifyIdentity("automations")
ok("identity provisioned (org seeds concepts)", !!identity.orgId, identity.email)
const signIn = await req("/api/auth/sign-in/email", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: identity.email, password: identity.password }),
})
ok("sign-in", signIn.ok, `${signIn.status}`)
if (!signIn.ok) {
  console.log(await signIn.text())
  process.exit(1)
}
await req("/api/auth/organization/set-active", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ organizationId: identity.orgId }),
})

// ── the real RPC client, cookie-authenticated ──
const CookieFetch = Layer.succeed(FetchHttpClient.Fetch, ((
  input: RequestInfo | URL,
  init?: RequestInit,
) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), cookie } })) as typeof fetch)
const ProtocolLive = RpcClient.layerProtocolHttp({ url: `${API}/api/rpc` }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CookieFetch),
  Layer.provide(RpcSerialization.layerNdjson),
)
const makeClient = RpcClient.make(KingsmakerRpcs)
type Client = Effect.Effect.Success<typeof makeClient>
class ApiClient extends Context.Tag("verify/ApiClient")<ApiClient, Client>() {}
const runtime = ManagedRuntime.make(
  Layer.scoped(ApiClient, makeClient).pipe(Layer.provide(ProtocolLive)),
)
const call = <A, E>(f: (c: Client) => Effect.Effect<A, E>): Promise<A> =>
  runtime.runPromise(Effect.flatMap(ApiClient, f) as Effect.Effect<A, E, never>)

const failCode = async (f: (c: Client) => Effect.Effect<unknown, unknown>) => {
  const result = await runtime.runPromise(
    Effect.either(
      Effect.flatMap(ApiClient, f) as Effect.Effect<unknown, { code?: string; message?: string }>,
    ),
  )
  return result._tag === "Right" ? null : (result.left.code ?? `no code: ${result.left.message}`)
}

// ── fixture: a concept with a Stage enum + a Notes text field ──
const concept = await call((c) => c.createConcept({ name: `AutoDeal ${Date.now()}` }))
const stage = await call((c) =>
  c.addField({
    conceptId: concept.id,
    name: "Stage",
    kind: "enum",
    config: { options: ["open", "nego", "won", "lost"] },
  }),
)
const notes = await call((c) => c.addField({ conceptId: concept.id, name: "Notes", kind: "text" }))
const flag = await call((c) => c.addField({ conceptId: concept.id, name: "Flag", kind: "text" }))
ok("fixture concept + fields", !!concept.id && !!stage.id && !!notes.id)

// ── 1. an enabled rule fires on a real edit ───────────────────────────────────
const winner = await call((c) =>
  c.createAutomation({
    name: "Stage → won sets Flag",
    trigger: { kind: "record.changed", conceptId: concept.id, fieldId: stage.id },
    conditions: [{ field: stage.id, op: "changedTo", value: "won" }],
    actions: [{ kind: "setField", fieldId: flag.id, value: "closed {{trigger.to}}" }],
    enabled: true,
  }),
)
ok("automation created enabled", winner.enabled)

const deal = await call((c) =>
  c.createInstance({ conceptId: concept.id, fields: { [stage.id]: "nego" } }),
)
// The edit that should trigger it.
const moved = await call((c) =>
  c.updateInstance({
    id: deal.id,
    expectedVersion: deal.version,
    patch: { [stage.id]: "won" },
  }),
)
ok("record moved to won", moved.state[stage.id] === "won")

const afterFire = await until(
  () => call((c) => c.getInstance({ id: deal.id })),
  (d) => typeof d.instance.state[flag.id] === "string",
)
ok(
  "1. the rule FIRED and wrote the field",
  afterFire.instance.state[flag.id] === "closed won",
  String(afterFire.instance.state[flag.id] ?? "(unset)"),
)

const winnerRuns = await until(
  () => call((c) => c.listAutomationRuns({ automationId: winner.id })),
  (rs) => rs.some((r) => r.status === "ok"),
)
const okRun = winnerRuns.find((r) => r.status === "ok")
ok("   run recorded as ok", !!okRun, okRun ? JSON.stringify(okRun.detail.actions) : "none")
ok("   run points at the record", okRun?.subjectId === deal.id)
ok("   run carries the triggering event id", typeof okRun?.eventId === "number")

// The trace: an AutomationRan on the record's own activity feed.
const feed = await until(
  () => call((c) => c.getActivity({ subjectId: deal.itemId })),
  (items) => items.some((i) => i.eventType === "AutomationRan"),
)
ok(
  "   the record's activity feed explains itself",
  feed.some((i) => i.eventType === "AutomationRan"),
)

// ── 2. changedTo is a TRANSITION, not a resting value ─────────────────────────
// The record is already `won`. An unrelated edit must NOT re-fire the rule.
const beforeCount = (await call((c) => c.listAutomationRuns({ automationId: winner.id }))).filter(
  (r) => r.status === "ok",
).length
const cur = await call((c) => c.getInstance({ id: deal.id }))
await call((c) =>
  c.updateInstance({
    id: deal.id,
    expectedVersion: cur.instance.version,
    patch: { [notes.id]: "an unrelated edit" },
  }),
)
// Give the runner the same budget it had to fire the first time.
await new Promise((r) => setTimeout(r, 2500))
const afterUnrelated = (
  await call((c) => c.listAutomationRuns({ automationId: winner.id }))
).filter((r) => r.status === "ok").length
ok(
  "2. an unrelated edit on an already-won record does NOT re-fire",
  afterUnrelated === beforeCount,
  `ok runs ${beforeCount} → ${afterUnrelated}`,
)

// ── 3. the one-hop guard ──────────────────────────────────────────────────────
// This rule watches the field the FIRST automation writes. If chaining were
// possible, automation 1's setField would trigger it.
const chainer = await call((c) =>
  c.createAutomation({
    name: "Should never run (watches Flag)",
    trigger: { kind: "record.changed", conceptId: concept.id, fieldId: flag.id },
    actions: [{ kind: "setField", fieldId: notes.id, value: "chained!" }],
    enabled: true,
  }),
)
const deal2 = await call((c) =>
  c.createInstance({ conceptId: concept.id, fields: { [stage.id]: "nego" } }),
)
await call((c) =>
  c.updateInstance({
    id: deal2.id,
    expectedVersion: deal2.version,
    patch: { [stage.id]: "won" },
  }),
)
// Wait for automation 1 to fire on deal2 (it writes Flag) …
const deal2Fired = await until(
  () => call((c) => c.getInstance({ id: deal2.id })),
  (d) => typeof d.instance.state[flag.id] === "string",
)
ok("   automation 1 fired on the second record", !!deal2Fired.instance.state[flag.id])
// … then give the chainer every chance to react to that write.
await new Promise((r) => setTimeout(r, 2500))
const chainRuns = await call((c) => c.listAutomationRuns({ automationId: chainer.id }))
const chainActed = chainRuns.filter((r) => r.status === "ok").length
const deal2After = await call((c) => c.getInstance({ id: deal2.id }))
ok(
  "3. ONE-HOP: an automation's own write triggers nothing",
  chainActed === 0 && deal2After.instance.state[notes.id] !== "chained!",
  `chainer ok-runs ${chainActed}`,
)

// ── 4. a disabled rule stays silent ───────────────────────────────────────────
const off = await call((c) =>
  c.createAutomation({
    name: "Disabled rule",
    trigger: { kind: "record.created", conceptId: concept.id },
    actions: [{ kind: "setField", fieldId: notes.id, value: "should not happen" }],
  }),
)
ok("   created disabled by default", !off.enabled)
await call((c) => c.createInstance({ conceptId: concept.id, fields: { [stage.id]: "open" } }))
await new Promise((r) => setTimeout(r, 2000))
const offRuns = await call((c) => c.listAutomationRuns({ automationId: off.id }))
ok("4. a disabled rule never runs", offRuns.length === 0, `${offRuns.length} runs`)

// ── 5. a non-match records a skip (not silence) ───────────────────────────────
const picky = await call((c) =>
  c.createAutomation({
    name: "Only lost deals",
    trigger: { kind: "record.changed", conceptId: concept.id, fieldId: stage.id },
    conditions: [{ field: stage.id, op: "changedTo", value: "lost" }],
    actions: [{ kind: "setField", fieldId: notes.id, value: "lost it" }],
    enabled: true,
  }),
)
const deal3 = await call((c) =>
  c.createInstance({ conceptId: concept.id, fields: { [stage.id]: "open" } }),
)
await call((c) =>
  c.updateInstance({
    id: deal3.id,
    expectedVersion: deal3.version,
    patch: { [stage.id]: "nego" },
  }),
)
// Wait for the run to SETTLE, not merely to exist: `claimRun` inserts the row
// before acting (that's the idempotency guard), so a freshly-claimed row is
// still `reason: "running"` for a few ms.
const pickyRuns = await until(
  () => call((c) => c.listAutomationRuns({ automationId: picky.id })),
  (rs) => rs.some((r) => r.finishedAt !== null),
)
const skip = pickyRuns.find((r) => r.status === "skipped")
ok(
  "5. a non-matching event records a SKIP with a reason",
  skip?.detail.reason === "conditions",
  skip ? String(skip.detail.reason) : "no run recorded",
)

// ── the dry run writes nothing ────────────────────────────────────────────────
const notesBefore = (await call((c) => c.getInstance({ id: deal3.id }))).instance.state[notes.id]
const dry = await call((c) => c.testAutomation({ id: picky.id }))
const notesAfter = (await call((c) => c.getInstance({ id: deal3.id }))).instance.state[notes.id]
ok("dry run reports a scan", dry.scanned > 0, `${dry.matched}/${dry.scanned}`)
ok("dry run wrote nothing", notesBefore === notesAfter)
ok(
  "dry run warns that transitions can't be previewed",
  typeof dry.note === "string" && dry.note.includes("transition"),
  String(dry.note),
)

// ── validation is enforced at the boundary ────────────────────────────────────
ok(
  "rejects an automation with no actions",
  (await failCode((c) =>
    c.createAutomation({
      name: "bad",
      trigger: { kind: "record.changed" },
      actions: [],
    }),
  )) !== null,
)
ok(
  "rejects a non-http webhook",
  (await failCode((c) =>
    c.createAutomation({
      name: "bad",
      trigger: { kind: "record.changed" },
      actions: [{ kind: "webhook", url: "file:///etc/passwd" }],
    }),
  )) !== null,
)

// ── archive / restore / delete ────────────────────────────────────────────────
const archived = await call((c) => c.archiveAutomation({ id: off.id }))
ok("archive stops + hides it", !!archived.archivedAt && !archived.enabled)
const restored = await call((c) => c.restoreAutomation({ id: off.id }))
ok("restore leaves it OFF (no silent resume)", !restored.archivedAt && !restored.enabled)
await call((c) => c.deleteAutomation({ id: off.id }))
const listAfter = await call((c) => c.listAutomations({ includeArchived: true }))
ok("delete removes it", !listAfter.some((a) => a.id === off.id), `${listAfter.length} left`)

// ── cleanup: leave the org tidy ───────────────────────────────────────────────
for (const a of await call((c) => c.listAutomations({ includeArchived: true }))) {
  await call((cl) => cl.deleteAutomation({ id: a.id }))
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
