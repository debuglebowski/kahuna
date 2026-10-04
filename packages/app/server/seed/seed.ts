import { Effect } from "effect"
import {
  AccessRoleService,
  ConceptService,
  DashboardService,
  FieldService,
  OrgContext,
  TaskPriorityService,
  TaskStatusService,
} from "#engine"
import { conceptDashboardSeed } from "../use-cases"
import { type ConceptSpec, defaultTaskPriorities, defaultTaskStatuses, kahunaSpec } from "./spec"

/** Get a concept by name, creating it if absent (idempotent). */
const ensureConcept = (concepts: ConceptService, spec: ConceptSpec) =>
  concepts.getByName(spec.name).pipe(
    Effect.catchTag("ConceptNotFound", () =>
      concepts.create({
        name: spec.name,
        pluralName: spec.pluralName,
        description: spec.description,
        icon: spec.icon,
        color: spec.color,
      }),
    ),
  )

/**
 * Seed the Kahuna concepts + fields for the current org (OrgContext).
 * Two passes: create every concept first, then add fields — so `relation`
 * fields can resolve their `targetName` to a concept id. Idempotent: re-running
 * skips concepts/fields that already exist, and every create flows through the
 * engine's event-sourced append path.
 */
export const seedKahuna = Effect.gen(function* () {
  const concepts = yield* ConceptService
  const fields = yield* FieldService
  const taskStatuses = yield* TaskStatusService
  const taskPriorities = yield* TaskPriorityService
  const dashboards = yield* DashboardService
  const accessRoles = yield* AccessRoleService

  // Access control: seed the preset roles (Admin/Member + the automation one).
  // Idempotent per role key, and the presets reproduce today's behaviour exactly
  // — see BUILTIN_ROLES.
  yield* accessRoles.ensureBuiltins

  // The founding owner gets Admin explicitly, here, once. Owner is Layer 0 now —
  // `configure` on `role`/`member` only (see `layer0Rules`) — not the blanket
  // access it used to be, so without this a brand-new org's only member would be
  // unable to create a concept, connect an integration, or do anything past
  // managing roles and people, with no UI path yet to grant themselves Admin
  // (that arrives with the member access page). This is ONLY for creation: this
  // effect has exactly one caller (`auth.ts`'s `afterCreateOrganization`, itself
  // called with `systemScope(orgId, user.id)`), so `OrgContext.actor` is always
  // the person who just created the org — never a later join or an owner
  // *promotion*, which must NOT carry this bonus grant (see `syncMembershipRole`,
  // which stays Member-only for everyone joining afterwards, owner or not).
  const { actor } = yield* OrgContext
  const admin = yield* accessRoles.getByKey("admin")
  if (admin) yield* accessRoles.assign(admin.id, actor)

  // Annotation layer: seed the org's default task statuses + priorities (idempotent).
  yield* taskStatuses.ensureDefaults(defaultTaskStatuses)
  yield* taskPriorities.ensureDefaults(defaultTaskPriorities)

  const idByName = new Map<string, string>()
  for (const spec of kahunaSpec) {
    const concept = yield* ensureConcept(concepts, spec)
    idByName.set(spec.name, concept.id)
  }

  // Every concept starts with an ordinary org dashboard (its table as one list
  // widget). Idempotent by name — like the concepts above, renames after seeding
  // are the org's own business.
  const existingDashboards = yield* dashboards.list()
  const dashNames = new Set(existingDashboards.map((d) => d.name))
  for (const spec of kahunaSpec) {
    if (dashNames.has(spec.name)) continue
    yield* dashboards.create({
      name: spec.name,
      icon: spec.icon ?? null,
      scope: "org",
      body: conceptDashboardSeed(idByName.get(spec.name)!),
    })
  }

  for (const spec of kahunaSpec) {
    const conceptId = idByName.get(spec.name)!
    const existing = yield* fields.listFields(conceptId)
    const have = new Set(existing.map((f) => f.name))
    for (const field of spec.fields) {
      if (have.has(field.name)) continue
      const config =
        field.kind === "relation" && field.targetName
          ? { ...(field.config ?? {}), target: idByName.get(field.targetName) }
          : field.config
      yield* fields.addField({
        conceptId,
        name: field.name,
        kind: field.kind,
        config,
        icon: field.icon,
      })
    }
  }

  return { concepts: kahunaSpec.length }
})
