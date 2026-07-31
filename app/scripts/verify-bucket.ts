/**
 * End-to-end verification of the widget-owned files feature. Signs up a fresh user
 * + org, then drives the REAL surfaces the widget uses: the bucket upload route,
 * listFiles at every scope, download, and purgeBucket — the RPCs through the same
 * Effect client the browser builds.
 *
 * Defaults to the throwaway stack (API :3199) so a run can't disturb the
 * slay-managed one; point API/ORIGIN at :3100/:5100 to verify the managed stack.
 */
import { FetchHttpClient } from "@effect/platform"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { KingsmakerRpcs } from "../rpc/contract"

const API = process.env.API ?? "http://localhost:3199"
const ORIGIN = process.env.ORIGIN ?? "http://localhost:5199"
let cookie = ""

const req = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(cookie ? { cookie } : {}),
      origin: ORIGIN,
    },
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

// ── session ──
const email = `bucket-verify-${Date.now()}@example.test`
const signup = await req("/api/auth/sign-up/email", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "password12345", name: "Bucket Verify" }),
})
ok("signup", signup.ok, `${signup.status}`)
if (!signup.ok) {
  console.log(await signup.text())
  process.exit(1)
}
const orgRes = await req("/api/auth/organization/create", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Verify Co", slug: `verify-${Date.now()}` }),
})
const newOrg = await orgRes.json()
ok("org created (seeds concepts)", orgRes.ok && !!newOrg.id, `${orgRes.status}`)
const setActive = await req("/api/auth/organization/set-active", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ organizationId: newOrg.id }),
})
ok("org active on the session", setActive.ok, `${setActive.status}`)

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

const listFiles = (filter: Record<string, unknown>) =>
  call((c) => c.listFiles(filter as never)) as Promise<
    ReadonlyArray<{ id: string; itemId: string | null; bucketId: string | null }>
  >

// ── uploads ──
const bucketId = crypto.randomUUID()
const privateBucket = crypto.randomUUID()
// `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: the default type param is
// `ArrayBufferLike`, which includes SharedArrayBuffer and so is not a `BlobPart`.
const upload = (bucket: string, name: string, body: Uint8Array<ArrayBuffer>, shared: boolean) => {
  const form = new FormData()
  form.append("file", new File([body], name, { type: "application/pdf" }))
  return req(`/api/buckets/${bucket}/attachments?shared=${shared}`, { method: "POST", body: form })
}
const up1 = await upload(
  bucketId,
  "handbook.pdf",
  new TextEncoder().encode("%PDF-1.4\nwidget-owned handbook\n%%EOF"),
  true,
)
const att1 = await up1.json()
ok("bucket upload accepted", up1.ok, `${up1.status}`)
ok(
  "uploaded file belongs to no record",
  att1.itemId === null,
  `itemId=${JSON.stringify(att1.itemId)}`,
)
ok("uploaded file carries its bucket", att1.bucketId === bucketId)
const up2 = await upload(
  privateBucket,
  "secret.pdf",
  new TextEncoder().encode("%PDF secret payload"),
  false,
)
const att2 = await up2.json()
ok("private bucket upload accepted", up2.ok, `${up2.status}`)

// ── listing ──
const own = await listFiles({ bucketId })
ok("widget lists its own file", own.length === 1 && own[0]?.id === att1.id, `n=${own.length}`)
const priv = await listFiles({ bucketId: privateBucket })
ok(
  "private widget lists its own file",
  priv.length === 1 && priv[0]?.id === att2.id,
  `n=${priv.length}`,
)
const orgIds = (await listFiles({})).map((a) => a.id)
ok("org scope includes the shared bucket file", orgIds.includes(att1.id))
ok("org scope EXCLUDES the private bucket file", !orgIds.includes(att2.id), `orgN=${orgIds.length}`)

// ── download: "private" hides from lists, it does not lock the link ──
const dl = await req(`/api/attachments/${att2.id}/download`)
const dlBody = await dl.text()
ok(
  "private file still downloads by direct link",
  dl.ok && dlBody.includes("secret"),
  `${dl.status}`,
)

const dlShared = await req(`/api/attachments/${att1.id}/download`)
ok(
  "shared bucket file downloads",
  dlShared.ok && (await dlShared.text()).includes("handbook"),
  `${dlShared.status}`,
)

// ── 25 MB cap ──
const bigForm = new FormData()
bigForm.append(
  "file",
  new File([new Uint8Array(26 * 1024 * 1024)], "huge.bin", { type: "application/octet-stream" }),
)
const big = await req(`/api/buckets/${bucketId}/attachments?shared=true`, {
  method: "POST",
  body: bigForm,
})
const bigBody = await big.json().catch(() => null)
ok(
  "26 MB upload refused with 413",
  big.status === 413 && bigBody?.error === "ATTACHMENT_TOO_LARGE",
  `${big.status} ${JSON.stringify(bigBody)?.slice(0, 140)}`,
)

// ── flipping sharing after the fact (the widget's toggle on an existing bucket) ──
// The flag is stamped per row at upload, so this is what makes "private" mean
// private for files that are already there.
const flipped = (await call((c) =>
  c.setBucketShared({ bucketId, shared: false }),
)) as ReadonlyArray<{ id: string }>
ok(
  "setBucketShared reports the re-stamped rows",
  flipped.length === 1 && flipped[0]?.id === att1.id,
  `n=${flipped.length}`,
)
ok(
  "the once-shared file is now hidden from org scope",
  !(await listFiles({})).map((a) => a.id).includes(att1.id),
)
ok("its own widget still lists it", (await listFiles({ bucketId })).length === 1)
ok(
  "re-applying the same value changes nothing",
  ((await call((c) => c.setBucketShared({ bucketId, shared: false }))) as ReadonlyArray<unknown>)
    .length === 0,
)
await call((c) => c.setBucketShared({ bucketId, shared: true }))
ok(
  "flipping back re-exposes it at org scope",
  (await listFiles({})).map((a) => a.id).includes(att1.id),
)

// ── archive/restore still work on a bucket file (uploader-or-admin gate) ──
await call((c) => c.archiveFile({ id: att1.id } as never))
ok("archived file drops out of the default list", (await listFiles({ bucketId })).length === 0)
ok(
  "archived file shows with includeArchived",
  (await listFiles({ bucketId, includeArchived: true })).length === 1,
)
await call((c) => c.restoreFile({ id: att1.id } as never))
ok("restored file is listed again", (await listFiles({ bucketId })).length === 1)

// ── purgeBucket (what the delete prompt calls) ──
const purged = (await call((c) => c.purgeBucket({ bucketId }))) as ReadonlyArray<{ id: string }>
ok(
  "purgeBucket returns the purged rows",
  purged.length === 1 && purged[0]?.id === att1.id,
  `n=${purged.length}`,
)
ok(
  "purged bucket lists nothing",
  (await listFiles({ bucketId, includeArchived: true })).length === 0,
)
const dlGone = await req(`/api/attachments/${att1.id}/download`)
ok("purged blob is gone", !dlGone.ok, `${dlGone.status}`)
ok("purged file gone from org scope", !(await listFiles({})).map((a) => a.id).includes(att1.id))
ok("the other bucket is untouched", (await listFiles({ bucketId: privateBucket })).length === 1)
ok(
  "purging an unknown bucket is a no-op",
  ((await call((c) => c.purgeBucket({ bucketId: crypto.randomUUID() }))) as ReadonlyArray<unknown>)
    .length === 0,
)

await runtime.dispose()
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
