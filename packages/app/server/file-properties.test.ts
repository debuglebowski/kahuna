import { randomUUID } from "node:crypto"
import {
  type FileRef,
  KahunaRpcs,
  layerRpcProtocolHttp,
  type RecordDetail,
} from "@kahunalabs/contract"
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { describe, expect, it } from "vitest"
import { type EngineServices, emptyPolicy, type OrgContext } from "#engine"
import { auth } from "./auth"
import { createUserDirect } from "./provision"
import { handleApi } from "./router"
import { rpcHandler } from "./rpc"
import { runEngine } from "./runtime"
import * as uc from "./use-cases"

/**
 * File properties end to end, through the REAL entry points: the multipart upload
 * route (`?field=`) and the typed RPC handler, with two sessions (owner + member)
 * so the uploader-or-admin rule is distinguishable from "nobody checked".
 */

const PASSWORD = "password12345"
const HOST = "http://localhost:3100"

const signUp = async () => {
  const email = `fp-${randomUUID()}@test.dev`
  const created = await createUserDirect({ email, password: PASSWORD, name: "Tester" })
  return { email, userId: created.userId }
}

const cookieFor = async (email: string): Promise<string> => {
  const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true })
  return (res.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+?=)/)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ")
}

/** An in-process RPC client: the CLI's transport, with `fetch` routed straight
 *  into the server's handler instead of over the network. */
const rpcAs = (cookie: string) => {
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

const upload = async (cookie: string, recordId: string, name: string, fieldId?: string) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(name)]), name)
  const qs = fieldId ? `?field=${fieldId}` : ""
  const res = await handleApi(
    new Request(`${HOST}/api/records/${recordId}/attachments${qs}`, {
      method: "POST",
      body: form,
      headers: { cookie, origin: HOST },
    }),
  )
  if (!res) throw new Error("route not matched")
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { code?: string }) => e.code ?? String(e),
  )

const setup = async () => {
  const owner = await signUp()
  const member = await signUp()
  const org = await auth.api.createOrganization({
    body: {
      name: `Org ${randomUUID().slice(0, 8)}`,
      slug: `org-${randomUUID().slice(0, 8)}`,
      userId: owner.userId,
    },
  })
  if (!org) throw new Error("createOrganization returned null")
  await auth.api.addMember({
    body: { userId: member.userId, role: "member", organizationId: org.id },
  })
  const ownerCookie = await cookieFor(owner.email)
  const memberCookie = await cookieFor(member.email)
  const asOwner = rpcAs(ownerCookie)
  const asMember = rpcAs(memberCookie)

  const concept = await asOwner.call((c) =>
    c.createConcept({ name: `Policy ${randomUUID().slice(0, 6)}` }),
  )
  const field = (name: string, multiple: boolean) =>
    asOwner.call((c) =>
      c.addField({
        conceptId: concept.id,
        name,
        kind: "file",
        config: multiple ? { multiple } : {},
      }),
    )
  const many = await field("Attachments", true)
  const one = await field("Signed copy", false)
  const rv = await asOwner.call((c) => c.createRecord({ conceptId: concept.id, fields: {} }))
  return {
    orgId: org.id,
    owner,
    member,
    ownerCookie,
    memberCookie,
    asOwner,
    asMember,
    concept,
    many,
    one,
    rv,
  }
}

describe("file properties (HTTP + RPC)", () => {
  it("upload into a property, read it back on getRecord/listRecords, reorder, move, archive", async () => {
    const s = await setup()
    try {
      // Upload straight into the multi-file property, from both sessions.
      const a = await upload(s.ownerCookie, s.rv.recordId, "a.pdf", s.many.id)
      expect(a.status).toBe(200)
      expect(a.body.fieldId).toBe(s.many.id)
      const b = await upload(s.memberCookie, s.rv.recordId, "b.pdf", s.many.id)
      expect(b.status).toBe(200)
      const signed = await upload(s.ownerCookie, s.rv.recordId, "signed.pdf", s.one.id)
      expect(signed.status).toBe(200)
      // A loose upload is not a property value.
      await upload(s.ownerCookie, s.rv.recordId, "loose.txt")

      const detail = (await s.asOwner.call((c) => c.getRecord({ id: s.rv.id }))) as RecordDetail
      const files = detail.recordVersion.state[s.many.id] as ReadonlyArray<FileRef>
      expect(files.map((f) => f.filename)).toEqual(["a.pdf", "b.pdf"])
      expect((detail.recordVersion.state[s.one.id] as FileRef).filename).toBe("signed.pdf")

      const listed = await s.asMember.call((c) => c.listRecords({ conceptId: s.concept.id }))
      const row = listed.find((r) => r.id === s.rv.id)!
      expect((row.state[s.many.id] as ReadonlyArray<FileRef>).map((f) => f.filename)).toEqual([
        "a.pdf",
        "b.pdf",
      ])

      // The Files panel still lists everything on the record — one storage.
      const all = await s.asMember.call((c) => c.listFiles({ recordId: s.rv.recordId }))
      expect(all.map((f) => f.filename).sort()).toEqual([
        "a.pdf",
        "b.pdf",
        "loose.txt",
        "signed.pdf",
      ])

      // Reorder: any member who may write the record.
      const reordered = await s.asMember.call((c) =>
        c.reorderFieldFiles({
          recordId: s.rv.recordId,
          fieldId: s.many.id,
          ids: [b.body.id as string, a.body.id as string],
        }),
      )
      expect(reordered.map((f) => f.filename)).toEqual(["b.pdf", "a.pdf"])

      // Archive: uploader or admin — the member may not archive the owner's file…
      expect(await codeOf(s.asMember.call((c) => c.archiveFile({ id: a.body.id as string })))).toBe(
        "FORBIDDEN",
      )
      // …but any writer may MOVE anyone's file (nothing is deleted), out and back.
      const out = await s.asMember.call((c) =>
        c.moveFile({ id: a.body.id as string, fieldId: null }),
      )
      expect(out.fieldId).toBeNull()
      await s.asMember.call((c) => c.moveFile({ id: a.body.id as string, fieldId: s.many.id }))
      // The owner (admin) may archive anyone's.
      const moved = await s.asMember.call((c) =>
        c.moveFile({ id: b.body.id as string, fieldId: null }),
      )
      expect(moved.fieldId).toBeNull()
      await s.asOwner.call((c) => c.archiveFile({ id: a.body.id as string }))

      const after = (await s.asOwner.call((c) => c.getRecord({ id: s.rv.id }))) as RecordDetail
      expect(after.recordVersion.state[s.many.id]).toBeUndefined()

      // Writing a file property through record state is refused.
      expect(
        await codeOf(
          s.asOwner.call((c) =>
            c.updateRecord({
              id: s.rv.id,
              expectedVersion: after.recordVersion.version,
              patch: { [s.many.id]: [] },
            }),
          ),
        ),
      ).toBe("VALIDATION")
    } finally {
      await s.asOwner.dispose()
      await s.asMember.dispose()
    }
  })

  it("refuses an upload naming a field that isn't a file property of this record", async () => {
    const s = await setup()
    try {
      const text = await s.asOwner.call((c) =>
        c.addField({ conceptId: s.concept.id, name: "Note", kind: "text" }),
      )
      expect((await upload(s.ownerCookie, s.rv.recordId, "x.txt", text.id)).status).toBe(422)
      expect((await upload(s.ownerCookie, s.rv.recordId, "x.txt", randomUUID())).status).toBe(404)
      // Nothing was planted by the refused uploads.
      const files = await s.asOwner.call((c) => c.listFiles({ recordId: s.rv.recordId }))
      expect(files).toHaveLength(0)
    } finally {
      await s.asOwner.dispose()
      await s.asMember.dispose()
    }
  })

  it("a caller who cannot read the record can neither upload into nor reorder its properties", async () => {
    const s = await setup()
    try {
      const own = await upload(s.ownerCookie, s.rv.recordId, "secret.pdf", s.many.id)
      expect(own.status).toBe(200)
      // No rule at all: the concept (and so the record) is unreadable.
      const sealed = (eff: Effect.Effect<unknown, unknown, OrgContext | EngineServices>) =>
        runEngine(
          { orgId: s.orgId, actor: "intruder", role: "member", policy: emptyPolicy("intruder") },
          eff,
        )

      const planted = await sealed(
        uc.uploadAttachment(
          { recordId: s.rv.recordId, fieldId: s.many.id },
          "plant.pdf",
          "application/pdf",
          new TextEncoder().encode("x"),
        ),
      )
      expect(planted.ok).toBe(false)
      const reorder = await sealed(
        uc.reorderFieldFiles(s.rv.recordId, s.many.id, [own.body.id as string]),
      )
      expect(reorder.ok).toBe(false)
      const move = await sealed(uc.moveFile(own.body.id as string, null))
      expect(move.ok).toBe(false)

      // Nothing planted, nothing moved.
      const files = await s.asOwner.call((c) => c.listFiles({ recordId: s.rv.recordId }))
      expect(files.map((f) => [f.filename, f.fieldId])).toEqual([["secret.pdf", s.many.id]])
    } finally {
      await s.asOwner.dispose()
      await s.asMember.dispose()
    }
  })

  it("stage → createRecord({ files }) attaches them; another member can't claim them", async () => {
    const s = await setup()
    try {
      await s.asOwner.call((c) =>
        c.updateField({
          id: s.many.id,
          name: s.many.name,
          config: { multiple: true, requirement: "required" },
        }),
      )
      const stage = async (cookie: string, name: string) => {
        const form = new FormData()
        form.append("file", new Blob([new TextEncoder().encode(name)]), name)
        const res = await handleApi(
          new Request(`${HOST}/api/attachments/staged`, {
            method: "POST",
            body: form,
            headers: { cookie, origin: HOST },
          }),
        )
        return {
          status: res!.status,
          body: (await res!.json()) as { id: string; stagedUntil: string | null },
        }
      }
      const mine = await stage(s.ownerCookie, "policy.pdf")
      expect(mine.status).toBe(200)
      expect(mine.body.stagedUntil).not.toBeNull()

      // Required and empty: refused.
      expect(
        await codeOf(
          s.asOwner.call((c) => c.createRecord({ conceptId: s.concept.id, fields: {} })),
        ),
      ).toBe("VALIDATION")
      // The member can't claim the owner's staged upload.
      expect(
        await codeOf(
          s.asMember.call((c) =>
            c.createRecord({
              conceptId: s.concept.id,
              fields: {},
              files: { [s.many.id]: [mine.body.id] },
            }),
          ),
        ),
      ).toBe("NOT_FOUND")

      const created = await s.asOwner.call((c) =>
        c.createRecord({
          conceptId: s.concept.id,
          fields: {},
          files: { [s.many.id]: [mine.body.id] },
        }),
      )
      expect((created.state[s.many.id] as ReadonlyArray<FileRef>).map((f) => f.filename)).toEqual([
        "policy.pdf",
      ])
    } finally {
      await s.asOwner.dispose()
      await s.asMember.dispose()
    }
  })
})
