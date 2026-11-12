import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { Client } from "pg"
import { redactHistory, redactValue } from "../../scripts/redact-history"
import { BlobStore, collectBytes } from "../blob/BlobStore"
import { AnnotationService } from "../services/AnnotationService"
import { AttachmentService } from "../services/AttachmentService"
import { ConceptService } from "../services/ConceptService"
import { EventStore } from "../services/EventStore"
import { FieldService } from "../services/FieldService"
import { QueryService } from "../services/QueryService"
import { RecordService } from "../services/RecordService"
import { newOrgId, testLayer } from "./harness"

const name = "Disposable Person"
const email = "redaction-fixture@example.invalid"
const terms = [name, email]
const hasData = (value: unknown) => terms.some((term) => JSON.stringify(value).includes(term))
const withClient = async <A>(fn: (client: Client) => Promise<A>) => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe("manual history redaction", () => {
  it.effect(
    "purge retains personal content; manual redaction clears history after app edits/files purge and survives rebuild",
    () => {
      const org = newOrgId()
      return Effect.gen(function* () {
        const concepts = yield* ConceptService
        const fields = yield* FieldService
        const records = yield* RecordService
        const notes = yield* AnnotationService
        const attachments = yield* AttachmentService
        const events = yield* EventStore
        const query = yield* QueryService
        const blob = yield* BlobStore
        const concept = yield* concepts.create({ name: "PrivacyFixture" })
        const field = yield* fields.addField({ conceptId: concept.id, name: "Text", kind: "text" })
        const record = yield* records.create({
          conceptId: concept.id,
          fields: { [field.id]: `${name} ${email}` },
        })
        const old = yield* records.create({ conceptId: concept.id, fields: { [field.id]: email } })
        const note = yield* notes.createNote({
          subjectId: record.recordId,
          body: `${name} ${email}`,
        })
        const task = yield* notes.createTask({
          subjectId: record.recordId,
          title: `Contact ${name}`,
          description: {
            text: email,
            doc: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: email }] }],
            },
          },
        })
        const file = yield* attachments.upload({
          owner: { recordId: record.recordId },
          filename: `${name}.txt`,
          mimeType: "text/plain",
          data: new TextEncoder().encode(email),
        })
        const downloaded = yield* attachments.download(file.id)
        expect(
          new TextDecoder().decode(yield* Effect.promise(() => collectBytes(downloaded.body))),
        ).toBe(email)
        // Existing supported app operations clear CURRENT content, not historical payloads.
        yield* records.update({
          recordVersionId: record.id,
          expectedVersion: record.version,
          patch: { [field.id]: "[erased]" },
        })
        yield* notes.updateNote({ id: note.id, expectedVersion: note.version, body: "[erased]" })
        yield* notes.updateTask({
          id: task.id,
          expectedVersion: task.version,
          title: "[erased]",
          description: null,
        })
        yield* attachments.purge(file.id)
        yield* records.purge({ recordVersionId: old.id })
        expect(hasData(yield* events.readStream(record.id))).toBe(true)
        expect(hasData(yield* events.readStream(old.id))).toBe(true)
        expect(hasData(yield* events.readStream(note.id))).toBe(true)
        expect(hasData(yield* events.readStream(task.id))).toBe(true)
        expect(hasData(yield* events.readStream(file.id))).toBe(true)
        // Original behavior conclusively reproduced. Blob failure is checked, not assumed.
        expect((yield* blob.get(file.contentRef).pipe(Effect.exit))._tag).toBe("Failure")
        const result = yield* Effect.promise(() =>
          withClient(async (client) => {
            const preview = await redactHistory(client, org, terms)
            expect(preview.changedEvents).toBeGreaterThanOrEqual(6)
            const stillThere = await client.query("SELECT payload FROM events WHERE org_id = $1", [
              org,
            ])
            expect(hasData(stillThere.rows)).toBe(true) // dry run writes nothing
            const applied = await redactHistory(client, org, terms, preview.planDigest)
            expect(applied.eventIds).toEqual(preview.eventIds)
            expect((await redactHistory(client, org, terms)).changedEvents).toBe(0)
            return applied
          }),
        )
        expect(result.mode).toBe("applied")
        expect(hasData(yield* events.readAllForOrg({ limit: 2000 }))).toBe(false)
        expect(
          (yield* events.readStream(old.id)).some(
            (event) => event.eventType === "RecordVersionPurged",
          ),
        ).toBe(true)
        const rebuilt = yield* records.rebuild(record.id)
        expect(rebuilt.state[field.id]).toBe("[erased]")
        expect((yield* records.rebuild(old.id).pipe(Effect.flip))._tag).toBe(
          "RecordVersionNotFound",
        )
        expect(
          hasData(yield* query.findRecords({ conceptId: concept.id, includeArchived: true })),
        ).toBe(false)
        expect(hasData(yield* notes.getNote(note.id))).toBe(false)
        expect(hasData(yield* notes.getTask(task.id))).toBe(false)
        expect(
          (yield* attachments.list({ recordId: record.recordId, includeArchived: true })).length,
        ).toBe(0)
        // Independent broad DB check: every public row's JSON representation for this org.
        yield* Effect.promise(() =>
          withClient(async (client) => {
            const tables = await client.query(
              "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='org_id'",
            )
            for (const { table_name } of tables.rows) {
              if (!/^[a-z_]+$/.test(table_name)) throw new Error("Unexpected table name")
              const rows = await client.query(
                `SELECT to_jsonb(t) AS row FROM "${table_name}" t WHERE org_id=$1`,
                [org],
              )
              expect(hasData(rows.rows), table_name).toBe(false)
            }
          }),
        )
      }).pipe(Effect.provide(testLayer(org)))
    },
  )

  it("refuses structural changes, preserves types and treats strings literally", () => {
    const payload = {
      _tag: "RecordVersionUpdated",
      patch: { text: `a.*[b] ${name}`, count: 7, flag: true, none: null },
    }
    expect(redactValue(payload, ["a.*[b]"])).toEqual({
      ...payload,
      patch: { ...payload.patch, text: `[erased] ${name}` },
    })
    expect(() => redactValue({ _tag: name }, terms)).toThrow("structural")
    expect(() => redactValue({ subjectId: email }, terms)).toThrow("structural")
    expect(() => redactValue({ [email]: "x" }, terms)).toThrow("JSON key")
  })

  it("rejects stale previews, isolates organisations, rolls back a mid-batch SQL failure", async () =>
    withClient(async (client) => {
      const org = newOrgId(),
        other = newOrgId()
      const insert = async (orgId: string) =>
        (
          await client.query(
            "INSERT INTO events(org_id, subject_kind, subject_id, event_type, payload) VALUES ($1,'note',gen_random_uuid(),'NoteCreated',$2::jsonb) RETURNING id::text",
            [orgId, JSON.stringify({ _tag: "NoteCreated", body: email })],
          )
        ).rows[0].id
      const current = await client.query(
        "INSERT INTO annotations(org_id,type,body) VALUES ($1,'note',$2) RETURNING id",
        [org, email],
      )
      await expect(redactHistory(client, org, terms)).rejects.toThrow("Matching current data")
      await client.query("DELETE FROM annotations WHERE id=$1", [current.rows[0].id])
      await insert(org)
      const second = await insert(org)
      await insert(other)
      const preview = await redactHistory(client, org, terms)
      await insert(org)
      await expect(redactHistory(client, org, terms, preview.planDigest)).rejects.toThrow(
        "Preview changed",
      )
      const fresh = await redactHistory(client, org, terms)
      // Deliberate DB failure on a later row proves the first write also rolls back.
      await client.query(
        `CREATE FUNCTION redaction_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${second} THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$`,
      )
      await client.query(
        "CREATE TRIGGER redaction_test_fail BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION redaction_test_fail()",
      )
      await expect(redactHistory(client, org, terms, fresh.planDigest)).rejects.toThrow(
        "synthetic failure",
      )
      expect((await redactHistory(client, org, terms)).planDigest).toBe(fresh.planDigest)
      await client.query("DROP TRIGGER redaction_test_fail ON events")
      await client.query("DROP FUNCTION redaction_test_fail()")
      await redactHistory(client, org, terms, fresh.planDigest)
      expect((await redactHistory(client, org, terms)).changedEvents).toBe(0)
      expect((await redactHistory(client, other, terms)).changedEvents).toBe(1)
      await expect(redactHistory(client, org, [""])).rejects.toThrow("full, exact")
    }))
})
