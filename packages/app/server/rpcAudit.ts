import { Effect, Option } from "effect"
import { OrgContext } from "#engine"
import { securityEvent } from "./securityLog"

/**
 * Security audit for the typed RPC surface, applied once around the whole handler map
 * (rpc.ts) rather than inside ~150 handlers.
 *
 * Two things are logged, both keyed by RPC name so an operator can read them without
 * the code in front of them:
 *   - `authz.denied`  — ANY rpc that fails with FORBIDDEN. This covers the admin gate
 *     (`requireAction`) and the engine's per-record access checks alike, since both
 *     surface as the same RpcError code.
 *   - the events in `AUDITED_RPCS` — successful changes to who may do what: roles,
 *     rules, assignments, member deactivation.
 *
 * Payloads are never logged. Only the id-shaped fields in `ID_FIELDS` are lifted out
 * of one, and only if they are strings, so a free-text field can't ride along.
 */
/** `[event, targetKind]` per audited RPC. */
type Audited = readonly [event: string, kind: string]

export const AUDITED_RPCS: Readonly<Record<string, Audited>> = {
  // access control
  createRole: ["access.role.created", "role"],
  updateRole: ["access.role.updated", "role"],
  deleteRole: ["access.role.deleted", "role"],
  assignRole: ["access.role.assigned", "user"],
  unassignRole: ["access.role.unassigned", "user"],
  reorderMemberRoles: ["access.member_roles.reordered", "user"],
  ensurePersonalRole: ["access.personal_role.ensured", "user"],
  reassignRoleHolders: ["access.role_holders.reassigned", "role"],
  addRule: ["access.rule.added", "rule"],
  updateRule: ["access.rule.updated", "rule"],
  setRoleRules: ["access.role_rules.replaced", "role"],
  removeRule: ["access.rule.removed", "rule"],
  deactivateMember: ["member.deactivated", "user"],
  reactivateMember: ["member.reactivated", "user"],
  // schema administration
  createConcept: ["schema.concept.created", "concept"],
  updateConcept: ["schema.concept.updated", "concept"],
  setConceptTitleField: ["schema.concept.title_field_set", "concept"],
  setConceptSingleRecord: ["schema.concept.single_record_set", "concept"],
  archiveConcept: ["schema.concept.archived", "concept"],
  restoreConcept: ["schema.concept.restored", "concept"],
  deleteConcept: ["schema.concept.deleted", "concept"],
  createLabel: ["schema.label.created", "label"],
  renameLabel: ["schema.label.renamed", "label"],
  archiveLabel: ["schema.label.archived", "label"],
  restoreLabel: ["schema.label.restored", "label"],
  deleteLabel: ["schema.label.deleted", "label"],
  addField: ["schema.field.added", "field"],
  updateField: ["schema.field.updated", "field"],
  archiveField: ["schema.field.archived", "field"],
  restoreField: ["schema.field.restored", "field"],
  deleteField: ["schema.field.deleted", "field"],
  reorderFields: ["schema.field.reordered", "concept"],
  // admin-gated data deletion
  deleteRecordVersion: ["record.version.deleted", "record_version"],
  // workspace configuration
  createTaskStatus: ["config.task_status.created", "task_status"],
  updateTaskStatus: ["config.task_status.updated", "task_status"],
  archiveTaskStatus: ["config.task_status.archived", "task_status"],
  restoreTaskStatus: ["config.task_status.restored", "task_status"],
  reorderTaskStatuses: ["config.task_status.reordered", "task_status"],
  createTaskPriority: ["config.task_priority.created", "task_priority"],
  updateTaskPriority: ["config.task_priority.updated", "task_priority"],
  archiveTaskPriority: ["config.task_priority.archived", "task_priority"],
  restoreTaskPriority: ["config.task_priority.restored", "task_priority"],
  reorderTaskPriorities: ["config.task_priority.reordered", "task_priority"],
  addAnnotationField: ["config.annotation_field.added", "annotation_field"],
  updateAnnotationField: ["config.annotation_field.updated", "annotation_field"],
  archiveAnnotationField: ["config.annotation_field.archived", "annotation_field"],
  restoreAnnotationField: ["config.annotation_field.restored", "annotation_field"],
  reorderAnnotationFields: ["config.annotation_field.reordered", "annotation_field"],
  // automations: they write to everyone's records
  createAutomation: ["automation.created", "automation"],
  updateAutomation: ["automation.updated", "automation"],
  archiveAutomation: ["automation.archived", "automation"],
  restoreAutomation: ["automation.restored", "automation"],
  deleteAutomation: ["automation.deleted", "automation"],
}

/**
 * Admin-gated RPCs that change nothing, so they are deliberately not audited. Listed
 * so the invariant test (rpcAudit.test.ts) can demand that EVERY admin-gated handler
 * is either audited above or named here — a new admin RPC cannot slip in uncovered.
 */
export const ADMIN_READS: ReadonlySet<string> = new Set([
  "listRules",
  "roleHolders",
  "effectiveAccess",
  "explainAccess",
  "testAutomation", // dry run, writes nothing
])

/** Payload fields that are identifiers, in priority order. Strings only, short. */
const ID_FIELDS = ["userId", "ruleId", "roleId", "id", "conceptId"] as const

const idsOf = (payload: unknown): Partial<Record<(typeof ID_FIELDS)[number], string>> => {
  const out: Partial<Record<(typeof ID_FIELDS)[number], string>> = {}
  if (typeof payload !== "object" || payload === null) return out
  const p = payload as Record<string, unknown>
  for (const k of ID_FIELDS) {
    const v = p[k]
    if (typeof v === "string" && v.length <= 64) out[k] = v
  }
  return out
}

const isForbidden = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "FORBIDDEN"

/**
 * Wrap one handler. Anything that does not return an Effect (a streaming RPC) is
 * passed through untouched.
 */
export const instrumentHandler =
  (name: string, handler: (...args: never[]) => unknown) =>
  (...args: unknown[]): unknown => {
    const result = (handler as (...a: unknown[]) => unknown)(...args)
    if (!Effect.isEffect(result)) return result
    const payload = args[0]
    const audited = AUDITED_RPCS[name]

    return (result as Effect.Effect<unknown, unknown, OrgContext>).pipe(
      Effect.tap(() =>
        audited
          ? Effect.flatMap(Effect.serviceOption(OrgContext), (scope) =>
              Effect.sync(() => {
                const ids = idsOf(payload)
                const [event, kind] = audited
                // For a user-targeted role change the role is context, not the target.
                const targetId =
                  kind === "user"
                    ? ids.userId
                    : kind === "role"
                      ? (ids.roleId ?? ids.id)
                      : kind === "rule"
                        ? ids.ruleId
                        : (ids.id ?? ids.conceptId)
                securityEvent({
                  event,
                  outcome: "success",
                  actor: Option.getOrUndefined(scope)?.actor,
                  orgId: Option.getOrUndefined(scope)?.orgId,
                  targetKind: targetId ? kind : undefined,
                  targetId,
                  detail: { rpc: name, roleId: kind === "user" ? ids.roleId : undefined },
                })
              }),
            )
          : Effect.void,
      ),
      Effect.tapError((e) =>
        isForbidden(e)
          ? Effect.flatMap(Effect.serviceOption(OrgContext), (scope) =>
              Effect.sync(() =>
                securityEvent({
                  event: "authz.denied",
                  outcome: "denied",
                  actor: Option.getOrUndefined(scope)?.actor,
                  orgId: Option.getOrUndefined(scope)?.orgId,
                  reason: "FORBIDDEN",
                  detail: { rpc: name },
                }),
              ),
            )
          : Effect.void,
      ),
    )
  }

/** Wrap every handler in a `toLayer` map. Keys keep their names, so the RPC group's
 *  typing of the map is unaffected. */
export const instrumentRpcHandlers = <H extends object>(handlers: H): H =>
  Object.fromEntries(
    Object.entries(handlers).map(([name, fn]) => [
      name,
      instrumentHandler(name, fn as (...args: never[]) => unknown),
    ]),
  ) as H
