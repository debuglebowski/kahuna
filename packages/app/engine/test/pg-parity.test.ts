import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { PgTestLive } from "./harness"

/**
 * What the engine relies on from its Postgres driver, pinned.
 *
 * `@effect/sql-pg` 4 replaced `pg` (text protocol, everything-a-string defaults)
 * with its own binary-protocol client. Where the two differ, the engine is either
 * indifferent by construction or depends on the new behaviour — each case below
 * says which, so a driver change that breaks the assumption fails here, by name,
 * instead of somewhere far downstream.
 */

const run = <A, E>(f: (sql: PgClient.PgClient) => Effect.Effect<A, E>) =>
  Effect.flatMap(PgClient.PgClient, f).pipe(Effect.provide(PgTestLive))

describe("sql-pg 4 type parity", () => {
  it.effect("int8 decodes to bigint, which every reader funnels through Number()", () =>
    run((sql) =>
      Effect.gen(function* () {
        // `pg` returned int8 as a STRING. The engine never trusted either: every
        // bigint column (versions, event ids, size_bytes) is read as
        // `Number(row.x)` (rows.ts), which is exact for a bigint in range.
        const [row] = yield* sql<{ n: unknown; c: unknown; i: unknown }>`
          SELECT 9007199254740991::int8 AS n, COUNT(*) AS c, COUNT(*)::int AS i FROM (VALUES (1), (2)) v(x)`
        expect(typeof row!.n).toBe("bigint")
        expect(Number(row!.n)).toBe(Number.MAX_SAFE_INTEGER)
        expect(typeof row!.c).toBe("bigint")
        // The `::int` casts the engine puts on its counts keep them plain numbers.
        expect(row!.i).toBe(2)
      }),
    ),
  )

  it.effect("numeric stays a string, as it was", () =>
    run((sql) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ n: unknown }>`SELECT 12345.678::numeric AS n`
        expect(row!.n).toBe("12345.678")
      }),
    ),
  )

  it.effect("timestamptz round-trips a Date to the millisecond", () =>
    run((sql) =>
      Effect.gen(function* () {
        const at = new Date("2026-06-01T12:34:56.789Z")
        const [row] = yield* sql<{ t: unknown; same: unknown }>`
          SELECT ${at}::timestamptz AS t, ${at} = '2026-06-01T12:34:56.789Z'::timestamptz AS same`
        expect(row!.t).toBeInstanceOf(Date)
        expect((row!.t as Date).toISOString()).toBe(at.toISOString())
        expect(row!.same).toBe(true)
      }),
    ),
  )

  it.effect("uuid is a string; untyped string params bind against uuid and int columns", () =>
    run((sql) =>
      Effect.gen(function* () {
        const id = randomUUID()
        // A string parameter binds with no type, so Postgres infers it from the
        // statement — the same as `pg`, which is what every `org_id = ${orgId}`
        // and `id = ${id}` in the engine needs.
        const [row] = yield* sql<{ u: unknown; eq: unknown; n: unknown }>`
          SELECT ${id}::uuid AS u, ${id}::uuid = ${id} AS eq, 41 + ${"1"} AS n`
        expect(row!.u).toBe(id)
        expect(row!.eq).toBe(true)
        expect(row!.n).toBe(42)
      }),
    ),
  )

  it.effect("sql.in binds each id on its own, so a uuid list still matches", () =>
    run((sql) =>
      Effect.gen(function* () {
        const ids = [randomUUID(), randomUUID()]
        // A JS ARRAY parameter now binds as text[] — `uuid = ANY(text[])` has no
        // operator. The engine passes id lists through `sql.in`, never as one array.
        const rows = yield* sql<{ id: string }>`
          SELECT id FROM (VALUES (${ids[0]}::uuid), (${randomUUID()}::uuid)) v(id)
          WHERE ${sql.in("id", ids)}`
        expect(rows.map((r) => r.id)).toEqual([ids[0]])
      }),
    ),
  )

  it.effect("text[] decodes to a JS array; booleans and numbers keep their JS types", () =>
    run((sql) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ a: unknown; b: unknown; f: unknown; i: unknown }>`
          SELECT ARRAY['configure', '*']::text[] AS a, ${true} AS b, ${1.5} AS f, ${7} + 1 AS i`
        expect(row!.a).toEqual(["configure", "*"])
        expect(row!.b).toBe(true)
        expect(row!.f).toBe(1.5)
        expect(row!.i).toBe(8)
      }),
    ),
  )

  it.effect("json/jsonb decode parsed, top-level arrays included", () =>
    run((sql) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ o: unknown; a: unknown; j: unknown }>`
          SELECT '{"x":[1,{"y":null}]}'::jsonb AS o, '["a",1]'::jsonb AS a, '[true]'::json AS j`
        expect(row!.o).toEqual({ x: [1, { y: null }] })
        expect(row!.a).toEqual(["a", 1])
        expect(row!.j).toEqual([true])
      }),
    ),
  )

  it.effect("jsonb writes: sql.json, a stringified ::jsonb, and a bare string into a jsonb column", () =>
    run((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // A transaction pins one connection, so the TEMP table is visible to
          // every statement below, and is dropped with it.
          yield* sql`CREATE TEMP TABLE pg_parity (doc jsonb, ids jsonb) ON COMMIT DROP`
          // 1. sql.json now binds a real jsonb parameter, so a top-level ARRAY
          //    lands as a JSON array. (Under `pg` it became a Postgres array
          //    literal, which is why the engine stringifies arrays instead.)
          // 2. That `${JSON.stringify(x)}::jsonb` idiom must keep working.
          // 3. So must a bare stringified value into a jsonb column with no cast
          //    (AnnotationService's `label_ids = ${JSON.stringify(ids)}`).
          yield* sql`INSERT INTO pg_parity (doc, ids) VALUES (${sql.json(["a", { b: 1 }])}, ${JSON.stringify(["x"])}::jsonb)`
          yield* sql`INSERT INTO pg_parity (doc, ids) VALUES (${sql.json({ k: [1, 2] })}, ${JSON.stringify(["y", "z"])})`
          const rows = yield* sql<{ dt: string; it: string; doc: unknown; ids: unknown }>`
            SELECT jsonb_typeof(doc) AS dt, jsonb_typeof(ids) AS it, doc, ids FROM pg_parity ORDER BY dt`
          expect(rows).toEqual([
            { dt: "array", it: "array", doc: ["a", { b: 1 }], ids: ["x"] },
            { dt: "object", it: "array", doc: { k: [1, 2] }, ids: ["y", "z"] },
          ])
        }),
      ),
    ),
  )

  it.effect("undefined and null bind as SQL NULL", () =>
    run((sql) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ a: unknown; b: unknown }>`
          SELECT ${undefined}::text IS NULL AS a, ${null}::uuid IS NULL AS b`
        expect(row).toEqual({ a: true, b: true })
      }),
    ),
  )
})

describe("sql-pg 4 transactions", () => {
  it.effect("a failed transaction rolls back; a nested one is a savepoint", () =>
    run((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TEMP TABLE pg_parity_tx (v int) ON COMMIT DROP`
          yield* sql`INSERT INTO pg_parity_tx VALUES (1)`
          // The inner block fails after writing: only ITS write is undone, which
          // is what lets `deleteConcept` and friends compose `withTransaction`s.
          const inner = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO pg_parity_tx VALUES (2)`
                return yield* Effect.fail("boom" as const)
              }),
            )
            .pipe(Effect.flip)
          expect(inner).toBe("boom")
          yield* sql`INSERT INTO pg_parity_tx VALUES (3)`
          const rows = yield* sql<{ v: number }>`SELECT v FROM pg_parity_tx ORDER BY v`
          expect(rows.map((r) => r.v)).toEqual([1, 3])
        }),
      ),
    ),
  )

  it.effect("statements outside a transaction see only committed work", () =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const tag = `pg-parity-${randomUUID()}`
      // A real table, so a second pooled connection can look for the row.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO events (org_id, occurred_at, actor, subject_kind, subject_id, event_type, payload)
            VALUES (${tag}, now(), 'pg-parity', 'concept', ${randomUUID()}, 'Probe', ${sql.json({})})`
          return yield* Effect.fail("rollback" as const)
        }),
      ).pipe(Effect.flip)
      const after = yield* sql<{ n: number }>`SELECT COUNT(*)::int AS n FROM events WHERE org_id = ${tag}`
      expect(after[0]!.n).toBe(0)
    }).pipe(Effect.provide(PgTestLive)),
  )
})
