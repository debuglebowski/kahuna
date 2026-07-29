import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AttachmentService, MAX_UPLOAD_BYTES } from "../services/AttachmentService"
import { ConceptService } from "../services/ConceptService"
import { EventStore } from "../services/EventStore"
import { InstanceService } from "../services/InstanceService"
import { newOrgId, testLayer } from "./harness"

/** A concept + one instance; returns the head row (carries `itemId`). */
const seedItem = Effect.gen(function* () {
  const concepts = yield* ConceptService
  const instances = yield* InstanceService
  yield* concepts.create({ name: "Artifact" })
  return yield* instances.create({ conceptName: "Artifact", fields: {} })
})

describe("attachments", () => {
  it.effect("uploads to the item lineage, lists by scope, downloads intact, records an event", () =>
    Effect.gen(function* () {
      const instance = yield* seedItem
      const attachments = yield* AttachmentService
      const events = yield* EventStore
      const instances = yield* InstanceService

      const bytes = new TextEncoder().encode("DPA contract — binding text  ÿ")
      const att = yield* attachments.upload({
        owner: { itemId: instance.itemId },
        filename: "dpa.txt",
        mimeType: "text/plain",
        data: bytes,
      })
      expect(att.itemId).toBe(instance.itemId)
      expect(att.sizeBytes).toBe(bytes.length)
      expect(att.createdBy).toBe("tester")
      expect(att.archivedAt).toBeNull()

      // Item scope, instance-id resolution, concept scope, org scope.
      expect((yield* attachments.list({ itemId: instance.itemId })).length).toBe(1)
      expect((yield* attachments.list({ instanceId: instance.id }))[0]?.id).toBe(att.id)
      expect((yield* attachments.list({ conceptId: instance.conceptId })).length).toBe(1)
      expect((yield* attachments.list()).length).toBe(1)
      // A dangling instance id reads as empty, not an error.
      expect(
        (yield* attachments.list({ instanceId: "00000000-0000-0000-0000-000000000000" })).length,
      ).toBe(0)

      const { data } = yield* attachments.download(att.id)
      expect(Array.from(data)).toEqual(Array.from(bytes))

      // The event rides the attachment's own stream and never enters the
      // instance fold (version untouched).
      const stream = yield* events.readStream(att.id)
      expect(stream.map((e) => e.payload._tag)).toEqual(["AttachmentAdded"])
      expect((yield* instances.get(instance.id)).version).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect(
    "archive hides from the live list, restore brings it back, purge removes for good",
    () =>
      Effect.gen(function* () {
        const instance = yield* seedItem
        const attachments = yield* AttachmentService
        const events = yield* EventStore

        const att = yield* attachments.upload({
          owner: { itemId: instance.itemId },
          filename: "cv.pdf",
          mimeType: "application/pdf",
          data: new Uint8Array([1, 2, 3]),
        })

        const archived = yield* attachments.archive(att.id)
        expect(archived.archivedAt).not.toBeNull()
        expect((yield* attachments.list({ itemId: instance.itemId })).length).toBe(0)
        expect(
          (yield* attachments.list({ itemId: instance.itemId, includeArchived: true })).length,
        ).toBe(1)
        // Archived files stay downloadable.
        expect((yield* attachments.download(att.id)).data.length).toBe(3)

        const restored = yield* attachments.restore(att.id)
        expect(restored.archivedAt).toBeNull()
        expect((yield* attachments.list({ itemId: instance.itemId })).length).toBe(1)

        yield* attachments.purge(att.id)
        expect(
          (yield* attachments.list({ itemId: instance.itemId, includeArchived: true })).length,
        ).toBe(0)
        const err = yield* attachments.download(att.id).pipe(Effect.flip)
        expect(err._tag).toBe("AttachmentNotFound")

        // The full audit trail survives the purge (tombstone history).
        const stream = yield* events.readStream(att.id)
        expect(stream.map((e) => e.eventType)).toEqual([
          "AttachmentAdded",
          "AttachmentArchived",
          "AttachmentRestored",
          "AttachmentPurged",
        ])
        expect(
          stream.every((e) => (e.payload as { subjectId?: string }).subjectId === instance.itemId),
        ).toBe(true)
      }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("upload to an archived item is blocked (block-not-cascade)", () =>
    Effect.gen(function* () {
      const instance = yield* seedItem
      const instances = yield* InstanceService
      const attachments = yield* AttachmentService
      yield* instances.archiveItem({ itemId: instance.itemId })
      const err = yield* attachments
        .upload({
          owner: { itemId: instance.itemId },
          filename: "x.txt",
          data: new Uint8Array([0]),
        })
        .pipe(Effect.flip)
      expect(err._tag).toBe("ItemNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("download of an unknown attachment fails", () =>
    Effect.gen(function* () {
      const attachments = yield* AttachmentService
      const err = yield* attachments
        .download("00000000-0000-0000-0000-000000000000")
        .pipe(Effect.flip)
      expect(err._tag).toBe("AttachmentNotFound")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  // ── widget-owned buckets (no record) ────────────────────────────────────────

  it.effect("uploads to a bucket with no item, lists it, downloads intact", () =>
    Effect.gen(function* () {
      const attachments = yield* AttachmentService
      const events = yield* EventStore
      const bucketId = randomUUID()

      const bytes = new TextEncoder().encode("standalone doc")
      const att = yield* attachments.upload({
        owner: { bucketId },
        filename: "handbook.pdf",
        mimeType: "application/pdf",
        data: bytes,
      })
      // No record anywhere in the picture.
      expect(att.itemId).toBeNull()
      expect(att.bucketId).toBe(bucketId)
      expect(att.bucketShared).toBe(true)

      expect((yield* attachments.list({ bucketId })).map((a) => a.id)).toEqual([att.id])
      expect(Array.from((yield* attachments.download(att.id)).data)).toEqual(Array.from(bytes))
      // The event carries the bucket instead of a host item.
      const stream = yield* events.readStream(att.id)
      expect(stream.map((e) => e.eventType)).toEqual(["AttachmentAdded"])
      expect((stream[0]?.payload as { bucketId?: string }).bucketId).toBe(bucketId)
      expect((stream[0]?.payload as { subjectId?: string }).subjectId).toBeUndefined()
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("org scope lists shared bucket files and hides private ones", () =>
    Effect.gen(function* () {
      const instance = yield* seedItem
      const attachments = yield* AttachmentService
      const sharedBucket = randomUUID()
      const privateBucket = randomUUID()

      const onRecord = yield* attachments.upload({
        owner: { itemId: instance.itemId },
        filename: "on-record.txt",
        data: new Uint8Array([1]),
      })
      const shared = yield* attachments.upload({
        owner: { bucketId: sharedBucket, shared: true },
        filename: "shared.txt",
        data: new Uint8Array([2]),
      })
      const hidden = yield* attachments.upload({
        owner: { bucketId: privateBucket, shared: false },
        filename: "private.txt",
        data: new Uint8Array([3]),
      })
      expect(hidden.bucketShared).toBe(false)

      // Org scope: record files + shared buckets only. Private means private.
      const orgIds = (yield* attachments.list()).map((a) => a.id)
      expect(orgIds).toContain(onRecord.id)
      expect(orgIds).toContain(shared.id)
      expect(orgIds).not.toContain(hidden.id)

      // A private bucket is still fully visible through its own widget…
      expect((yield* attachments.list({ bucketId: privateBucket })).map((a) => a.id)).toEqual([
        hidden.id,
      ])
      // …and stays directly downloadable (privacy gates listing, not access).
      expect((yield* attachments.download(hidden.id)).data.length).toBe(1)

      // Record-shaped scopes can never surface bucket files: no item, no concept.
      const itemIds = (yield* attachments.list({ itemId: instance.itemId })).map((a) => a.id)
      expect(itemIds).toEqual([onRecord.id])
      const conceptIds = (yield* attachments.list({ conceptId: instance.conceptId })).map(
        (a) => a.id,
      )
      expect(conceptIds).toEqual([onRecord.id])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  // The flag is stamped per row at upload, so flipping the widget's toggle has to
  // re-stamp what's already in the bucket — otherwise "private" would only ever
  // apply to files uploaded after the switch.
  it.effect("setBucketShared re-stamps the files already in the bucket", () =>
    Effect.gen(function* () {
      const attachments = yield* AttachmentService
      const bucketId = randomUUID()
      const other = randomUUID()

      const first = yield* attachments.upload({
        owner: { bucketId, shared: true },
        filename: "early.txt",
        data: new Uint8Array([1]),
      })
      const untouched = yield* attachments.upload({
        owner: { bucketId: other, shared: true },
        filename: "elsewhere.txt",
        data: new Uint8Array([2]),
      })
      expect((yield* attachments.list()).map((a) => a.id)).toContain(first.id)

      // Turning sharing off hides the existing file from org scope…
      const changed = yield* attachments.setBucketShared(bucketId, false)
      expect(changed.map((a) => a.id)).toEqual([first.id])
      const orgIds = (yield* attachments.list()).map((a) => a.id)
      expect(orgIds).not.toContain(first.id)
      // …without reaching into a different bucket…
      expect(orgIds).toContain(untouched.id)
      // …while its own widget still lists it.
      expect((yield* attachments.list({ bucketId })).map((a) => a.id)).toEqual([first.id])

      // Idempotent: re-applying the same value changes nothing.
      expect(yield* attachments.setBucketShared(bucketId, false)).toEqual([])
      // And it flips back.
      expect((yield* attachments.setBucketShared(bucketId, true)).map((a) => a.id)).toEqual([
        first.id,
      ])
      expect((yield* attachments.list()).map((a) => a.id)).toContain(first.id)

      // An unknown bucket is a no-op, not a failure.
      expect(yield* attachments.setBucketShared(randomUUID(), false)).toEqual([])
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("purgeBucket clears the whole bucket, archived rows included", () =>
    Effect.gen(function* () {
      const attachments = yield* AttachmentService
      const events = yield* EventStore
      const bucketId = randomUUID()
      const keep = randomUUID()

      const a = yield* attachments.upload({
        owner: { bucketId },
        filename: "a.txt",
        data: new Uint8Array([1]),
      })
      const b = yield* attachments.upload({
        owner: { bucketId },
        filename: "b.txt",
        data: new Uint8Array([2]),
      })
      // A file in a DIFFERENT bucket must survive.
      const other = yield* attachments.upload({
        owner: { bucketId: keep },
        filename: "other.txt",
        data: new Uint8Array([3]),
      })
      yield* attachments.archive(b.id)

      const purged = yield* attachments.purgeBucket(bucketId)
      expect(purged.map((p) => p.id).sort()).toEqual([a.id, b.id].sort())
      expect((yield* attachments.list({ bucketId, includeArchived: true })).length).toBe(0)
      expect((yield* attachments.list({ bucketId: keep })).map((x) => x.id)).toEqual([other.id])
      // Bytes are gone with the rows.
      expect((yield* attachments.download(a.id).pipe(Effect.flip))._tag).toBe("AttachmentNotFound")
      // Tombstones survive, carrying the bucket.
      const stream = yield* events.readStream(a.id)
      expect(stream.map((e) => e.eventType)).toEqual(["AttachmentAdded", "AttachmentPurged"])
      expect((stream[1]?.payload as { bucketId?: string }).bucketId).toBe(bucketId)

      // An empty/unknown bucket purges to nothing rather than failing.
      expect((yield* attachments.purgeBucket(randomUUID())).length).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("an over-cap upload is rejected before anything is stored", () =>
    Effect.gen(function* () {
      const attachments = yield* AttachmentService
      const bucketId = randomUUID()
      const err = yield* attachments
        .upload({
          owner: { bucketId },
          filename: "huge.bin",
          data: new Uint8Array(MAX_UPLOAD_BYTES + 1),
        })
        .pipe(Effect.flip)
      expect(err._tag).toBe("AttachmentTooLarge")
      expect((yield* attachments.list({ bucketId })).length).toBe(0)
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )

  it.effect("the DB rejects a row owned by both or neither", () =>
    Effect.gen(function* () {
      const instance = yield* seedItem
      const sql = yield* PgClient.PgClient
      // SqlError's own message is generic; the violated constraint is on the pg cause.
      const violated = (itemId: string | null, bucketId: string | null) =>
        sql`INSERT INTO attachments (org_id, item_id, bucket_id, filename, content_ref)
            VALUES ('x', ${itemId}, ${bucketId}, 'f.txt', 'k')`.pipe(
          Effect.flip,
          Effect.map((e) => (e.cause as { constraint?: string })?.constraint),
        )

      // Both owners set, and neither — the attachments_one_owner CHECK.
      expect(yield* violated(instance.itemId, randomUUID())).toBe("attachments_one_owner")
      expect(yield* violated(null, null)).toBe("attachments_one_owner")
    }).pipe(Effect.provide(testLayer(newOrgId()))),
  )
})
