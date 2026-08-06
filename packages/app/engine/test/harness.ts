import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { PgClient } from "@effect/sql-pg"
import { Config, Layer } from "effect"
import { LocalFsBlobStore } from "../blob/local"
import type { AccessAction, AccessResourceType, AccessRule, PolicySet } from "../domain/access"
import { emptyPolicy } from "../domain/access"
import { EngineLive } from "../layers"
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
 * MUST track `AccessRoleService.BUILTIN_ROLES`'s `member` spec exactly — a stale
 * fixture here is what let a real field-visibility bug ship unnoticed once (a
 * blanket grant that outranked a per-field default). `field` doesn't exist as a
 * resource type any more (nor does `bucket` — both were removed entirely, not
 * merely trimmed from Member's grant), so there is no longer a shape for either
 * to drift out of sync with.
 *
 * For the five TEMPLATED types, each entry is the real blanket rule's actions
 * UNIONED with `view` — reproducing what `ensureBuiltins`'s materialization
 * injects into every EXISTING resource's per-resource rule (this fixture has no
 * real resource ids to scope a separate rule to, so the blanket union is the
 * accurate stand-in). `automation` gets no rule at all: reads there default OPEN
 * (`AutomationService.allowed`'s `fallback: true`), so an empty policy already
 * reproduces "member can read automations" correctly.
 *
 * `org`/`role`/`member` deliberately get NO rule — matching the real preset
 * exactly: only `configure` is ever decided against them, which Member never
 * holds — a rule here would silently make "an ordinary member" indistinguishable
 * from an admin, exactly the property `visibility.test.ts`'s `org`-`configure`
 * check exists to pin.
 *
 * Tests ABOUT access should build a narrower policy naming specific resources
 * instead — a blanket rule here would paper over exactly what they are checking.
 */
const MEMBER_GRANTS: ReadonlyArray<{
  readonly resourceType: AccessResourceType
  readonly actions: ReadonlyArray<AccessAction>
}> = [
  { resourceType: "concept", actions: ["create", "view"] },
  { resourceType: "record", actions: ["create", "view"] },
  { resourceType: "dashboard", actions: ["edit", "view"] },
  { resourceType: "view", actions: ["edit", "view"] },
  { resourceType: "task", actions: ["create", "view"] },
  { resourceType: "note", actions: ["create"] },
]

export const ordinaryMember = (actor: string): PolicySet => ({
  ...emptyPolicy(actor),
  rules: MEMBER_GRANTS.map(
    ({ resourceType, actions }, i): AccessRule => ({
      id: `test-member-${i}`,
      roleId: "test-role",
      actorId: null,
      effect: "allow",
      actions,
      resourceType,
      resourceId: null,
      conceptId: null,
      condition: null,
    }),
  ),
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
