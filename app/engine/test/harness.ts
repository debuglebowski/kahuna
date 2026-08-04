import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { PgClient } from "@effect/sql-pg"
import { Config, Layer } from "effect"
import { LocalFsBlobStore } from "../blob/local"
import { ACTION_ALL, emptyPolicy, type PolicySet } from "../domain/access"
import { EngineLive } from "../layers"
import { TEMPLATED_TYPES } from "../services/AccessDefaultsService"
import { OrgContext, type ScopeRole } from "../services/OrgContext"

/** SqlClient layer pointed at the dedicated test database. */
export const PgTestLive = PgClient.layerConfig({
  url: Config.redacted("TEST_DATABASE_URL"),
})

const BlobTestLive = LocalFsBlobStore(path.join(tmpdir(), "kingsmaker-test-blobs"))

/**
 * A policy standing in for AN ORDINARY MEMBER of a live org.
 *
 * Access is now one layer: a concept, dashboard, view or automation is readable
 * because a RULE says so, and materialization writes those rules when the resource is
 * created. A test that builds its fixtures directly through the services skips that,
 * so a `member` scope with no policy sees nothing — correctly, but that is rarely
 * what a test about something else means.
 *
 * This is the blanket equivalent: "may do everything, everywhere". Tests ABOUT access
 * should build a narrower policy naming specific resources instead — a blanket rule
 * here would paper over exactly what they are checking.
 */
export const ordinaryMember = (actor: string): PolicySet => ({
  ...emptyPolicy(actor),
  rules: TEMPLATED_TYPES.map((resourceType, i) => ({
    id: `test-${i}`,
    roleId: "test-role",
    actorId: null,
    effect: "allow" as const,
    actions: [ACTION_ALL],
    resourceType,
    resourceId: null,
    conceptId: null,
    condition: null,
  })),
})

/** A fully-provided engine layer scoped to one org (Engine + Pg + Blob + OrgContext).
 *
 *  `role` defaults to `"system"` so the existing suite keeps exercising the
 *  unfiltered engine — read visibility is asserted by tests that pass a role
 *  explicitly (`"member"` / `"admin"`), not by every test incidentally.
 *
 *  `policy` defaults to ABSENT, which now means "no rules, so nothing on the five
 *  templated types" — access fails CLOSED. `"system"` is exempt (it is the engine
 *  itself), which is why most of the suite is unaffected. A test needing a plain
 *  member should pass `ordinaryMember(actor)`. */
export const testLayer = (
  orgId: string,
  actor = "tester",
  role: ScopeRole = "system",
  policy?: PolicySet,
) =>
  Layer.provideMerge(
    EngineLive,
    Layer.mergeAll(
      PgTestLive,
      BlobTestLive,
      Layer.succeed(OrgContext, { orgId, actor, role, policy }),
    ),
  )

export const newOrgId = (): string => randomUUID()
