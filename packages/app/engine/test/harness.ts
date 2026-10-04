import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { PgClient } from "@effect/sql-pg"
import { Config, Layer } from "effect"
import { LocalFsBlobStore } from "../blob/local"
import type { AccessAction, AccessResourceType, AccessRule, PolicySet } from "../domain/access"
import { emptyPolicy, unrestrictedPolicy } from "../domain/access"
import { EngineLive } from "../layers"
import { OrgContext, type ScopeRole } from "../services/OrgContext"

/** SqlClient layer pointed at the dedicated test database. */
export const PgTestLive = PgClient.layerConfig({
  url: Config.redacted("TEST_DATABASE_URL"),
})

const BlobTestLive = LocalFsBlobStore(path.join(tmpdir(), "kahuna-test-blobs"))

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
 * `automation` now carries `view` like everything else. It used to carry no rule at
 * all, because reads there defaulted OPEN — `AutomationService.allowed` fell back to
 * `true`, the last gate in the app where silence granted. That fallback is `false`,
 * so an empty policy no longer reproduces "a member can read automations".
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
  // `edit` and the two `create`s below track the four gates added alongside
  // `RecordService.assertRecordEditable` — this list is "what the Member preset
  // grants", so it has to move with `BUILTIN_ROLES` or every test using an ordinary
  // member starts failing on writes the real Member can do.
  { resourceType: "record", actions: ["create", "edit", "view"] },
  { resourceType: "dashboard", actions: ["create", "edit", "view"] },
  { resourceType: "view", actions: ["create", "edit", "view"] },
  { resourceType: "task", actions: ["create", "view"] },
  { resourceType: "note", actions: ["create"] },
  { resourceType: "automation", actions: ["view"] },
]

export const ordinaryMember = (actor: string): PolicySet => ({
  ...emptyPolicy(actor),
  rules: MEMBER_GRANTS.map(
    ({ resourceType, actions }, i): AccessRule => ({
      id: `test-member-${i}`,
      roleId: "test-role",
      effect: "allow",
      actions,
      resourceType,
      resourceId: null,
      conceptId: null,
      condition: null,
    }),
  ),
})

/**
 * An ordinary member with one or more concepts taken away — what
 * `concepts.visibility = 'admin'` used to express before the column was dropped
 * (migration 0022).
 *
 * Two denies per concept, and both are needed: one hides the concept itself, one
 * hides its records. `scopeConceptRead` will not let a record grant reopen a concept
 * that was explicitly denied, but a concept deny alone leaves `recordRulesForConcept`
 * free to answer for the rows, so the record deny is what makes the list empty rather
 * than merely unreachable.
 *
 * Denies come FIRST in the array only for readability — `decide` resolves deny
 * before allow within a tier regardless of order.
 */
export const memberDenied = (actor: string, ...conceptIds: ReadonlyArray<string>): PolicySet => {
  const base = ordinaryMember(actor)
  return {
    ...base,
    rules: [
      ...conceptIds.flatMap(
        (conceptId): ReadonlyArray<AccessRule> => [
          {
            id: `test-deny-concept-${conceptId}`,
            roleId: "test-role",
            effect: "deny",
            actions: ["view"],
            resourceType: "concept",
            resourceId: conceptId,
            conceptId: null,
            condition: null,
          },
          {
            id: `test-deny-record-${conceptId}`,
            roleId: "test-role",
            effect: "deny",
            actions: ["view"],
            resourceType: "record",
            resourceId: null,
            conceptId,
            condition: null,
          },
        ],
      ),
      ...base.rules,
    ],
  }
}

/** A fully-provided engine layer scoped to one org (Engine + Pg + Blob + OrgContext).
 *
 *  `role` defaults to `"system"` so the existing suite keeps exercising the
 *  unfiltered engine — read visibility is asserted by tests that pass a role
 *  explicitly (`"member"` / `"admin"`), not by every test incidentally.
 *
 *  `policy` defaults to ABSENT, which for a person means "no rules at all" — access
 *  fails CLOSED. A test needing a plain member should pass `ordinaryMember(actor)`.
 *
 *  A `"system"` scope with no policy is given `unrestrictedPolicy`, because that is
 *  exactly what `server/runtime.ts:systemScope` builds and this fixture must not
 *  differ from it. The engine's exemption lives in ONE place — the `unrestricted`
 *  flag `decide()` short-circuits on — rather than being re-tested by hand at each
 *  gate, so a system scope carrying no policy would now genuinely see nothing. */
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
      Layer.succeed(OrgContext, {
        orgId,
        actor,
        role,
        policy: policy ?? (role === "system" ? unrestrictedPolicy(actor) : undefined),
      }),
    ),
  )

export const newOrgId = (): string => randomUUID()
