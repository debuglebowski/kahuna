import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { ConceptService } from "../services/ConceptService"
import { EVENT_CHANNEL, type EventEnvelope, EventStore } from "../services/EventStore"
import { InstanceService } from "../services/InstanceService"
import { newOrgId, testLayer } from "./harness"

describe("EventStore NOTIFY (live-sync envelope)", () => {
  // Real clock (plain `it`, not `it.effect`) so LISTEN delivery isn't virtualised.
  it("emits one envelope per committed event, conceptName included, none on rollback", async () => {
    const orgId = newOrgId()
    const rollbackId = randomUUID()
    const received: EventEnvelope[] = []

    const accId = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const concepts = yield* ConceptService
        const instances = yield* InstanceService
        const events = yield* EventStore

        const listener = yield* sql.listen(EVENT_CHANNEL).pipe(
          Stream.runForEach((raw) =>
            Effect.sync(() => {
              const env = JSON.parse(raw) as EventEnvelope
              if (env.org === orgId) received.push(env)
            }),
          ),
          Effect.fork,
        )
        yield* Effect.sleep("250 millis") // let LISTEN register

        yield* concepts.create({ name: "Account" })
        const acc = yield* instances.create({ conceptName: "Account", fields: {} })

        // Rolled-back transaction: append then fail -> the NOTIFY must be discarded,
        // which only holds if pg_notify rode the transaction connection.
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* events.append({
                subjectKind: "instance",
                subjectId: rollbackId,
                eventType: "InstanceUpdated",
                payload: { _tag: "InstanceUpdated", patch: {} },
                conceptName: "Account",
              })
              return yield* Effect.fail(new Error("boom"))
            }),
          )
          .pipe(Effect.catchAll(() => Effect.void))

        yield* Effect.sleep("400 millis") // let notifications drain
        yield* Fiber.interrupt(listener)
        return acc.id
      }).pipe(Effect.provide(testLayer(orgId)), Effect.scoped),
    )

    const instanceEnv = received.find((e) => e.subjectId === accId)
    expect(instanceEnv).toBeDefined()
    expect(instanceEnv?.kind).toBe("instance")
    expect(instanceEnv?.type).toBe("InstanceCreated")
    expect(instanceEnv?.concept).toBe("Account")

    // The concept creation is delivered too (subjectKind "concept", no conceptName).
    expect(received.some((e) => e.type === "ConceptCreated" && e.kind === "concept")).toBe(true)

    // The rolled-back append must NOT have been delivered.
    expect(received.some((e) => e.subjectId === rollbackId)).toBe(false)
  })
})
