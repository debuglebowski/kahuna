import type { AccessActionName, AccessResourceType, AccessRole } from "@kingsmaker/contract"
import { loadConfig, resolveProfile } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { note, printOne, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Access, after the 2026-08 cascade.
 *
 * Owner is Layer 0 of an ordered cascade rather than a bypass, a member's role
 * ORDER is their precedence, and the bottom of the stack is a deny. That last
 * point is why `access check` renders the whole layer trace: with a real
 * ordering, "why" is a sequence, and a single yes/no throws away the answer.
 */
const withApi = async <T>(
  profileFlag: string | undefined,
  f: (api: Api) => Promise<T>,
): Promise<T> => {
  const { profile } = resolveProfile(loadConfig(), profileFlag)
  const api = makeRuntime(profile)
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

const ACTIONS: ReadonlyArray<AccessActionName> = [
  "view",
  "create",
  "edit",
  "archive",
  "delete",
  "share",
  "configure",
]

const RESOURCES: ReadonlyArray<AccessResourceType> = [
  "org",
  "concept",
  "record",
  "field",
  "dashboard",
  "view",
  "automation",
  "bucket",
  "task",
  "note",
  "member",
  "role",
]

const findRole = (roles: ReadonlyArray<AccessRole>, name: string): AccessRole => {
  const n = name.trim().toLowerCase()
  const exact = roles.find((r) => r.id === name) ?? roles.find((r) => r.name.toLowerCase() === n)
  if (exact) return exact
  const partial = roles.filter((r) => r.name.toLowerCase().startsWith(n))
  if (partial.length === 1 && partial[0]) return partial[0]
  throw new CliError(
    partial.length > 1 ? `"${name}" matches ${partial.length} roles.` : `No role named "${name}".`,
    partial.length > 1 ? EXIT.usage : EXIT.notFound,
    `Roles: ${roles.map((r) => r.name).join(", ")}`,
  )
}

export const accessCommands: ReadonlyArray<Command> = [
  {
    path: "access check",
    summary: "What someone may do, and WHY — the layer trace behind one decision",
    usage:
      "access check [--user <id>] [--action <action> --resource <type> [--id <resource-id>]] [--json]",
    options: {
      user: { type: "string" },
      action: { type: "string" },
      resource: { type: "string" },
      id: { type: "string" },
      concept: { type: "string" },
    },
    run: async (ctx) => {
      const action = ctx.flags.action as string | undefined
      const resource = ctx.flags.resource as string | undefined
      await withApi(ctx.profile, async (api) => {
        // No question asked → the whole picture (`effectiveAccess`). A specific
        // question → `explainAccess`, which is the CLI-shaped one: it answers
        // yes/no AND shows every layer that spoke, in order.
        if (!action && !resource) {
          const me = await api.call((c) => c.myAccess())
          const effective = await api.call((c) =>
            c.effectiveAccess({ userId: ctx.flags.user as string | undefined }),
          )
          if (ctx.format === "json") {
            printOne(ctx.format, { ...me, ...effective } as unknown as Record<string, unknown>)
            return
          }
          printOne("table", {
            user: effective.userId,
            owner: me.isOwner ? "yes" : "no",
            canConfigure: me.canConfigure ? "yes" : "no",
            canConfigureRoles: me.canConfigureRoles ? "yes" : "no",
            roles: effective.roles.map((r) => r.name).join(", ") || "(none)",
          })
          note("")
          printRows(
            "table",
            effective.rules.map((r) => ({
              effect: r.effect,
              actions: r.actions.join(","),
              resource: r.resourceType,
              scoped: r.resourceId ? "one" : "all",
              via: r.viaRoleName ?? "(direct)",
              condition: r.condition ? "yes" : "",
            })),
            ["effect", "actions", "resource", "scoped", "via", "condition"],
          )
          return
        }

        if (!action || !resource) {
          throw new CliError(
            "Need --action and --resource together.",
            EXIT.usage,
            `Actions: ${ACTIONS.join(", ")}\nResources: ${RESOURCES.join(", ")}`,
          )
        }
        if (!ACTIONS.includes(action as AccessActionName)) {
          throw new CliError(
            `Unknown action "${action}".`,
            EXIT.usage,
            `Actions: ${ACTIONS.join(", ")}`,
          )
        }
        if (!RESOURCES.includes(resource as AccessResourceType)) {
          throw new CliError(
            `Unknown resource "${resource}".`,
            EXIT.usage,
            `Resources: ${RESOURCES.join(", ")}`,
          )
        }

        const explained = await api.call((c) =>
          c.explainAccess({
            userId: ctx.flags.user as string | undefined,
            action: action as AccessActionName,
            resourceType: resource as AccessResourceType,
            resourceId: (ctx.flags.id as string | undefined) ?? null,
            conceptId: (ctx.flags.concept as string | undefined) ?? null,
          }),
        )

        if (ctx.format === "json") {
          printOne(ctx.format, explained as unknown as Record<string, unknown>)
          return
        }
        printOne("table", {
          user: explained.userId,
          question: `${action} on ${resource}${explained.resourceId ? ` ${explained.resourceId}` : ""}`,
          answer: explained.outcome ? "ALLOWED" : "DENIED",
          decidedBy: explained.decidedByFallback
            ? `the fallback (${explained.fallback ? "allow" : "deny"})`
            : (explained.layers.find((l) => l.decided)?.label ?? "no layer"),
        })
        note("")
        // Silent layers are printed too. "Nothing said anything here" is the
        // most useful line in the trace when the answer surprises you.
        printRows(
          "table",
          explained.layers.map((l) => ({
            order: l.precedence,
            layer: l.label,
            verdict: l.verdict,
            decided: l.decided ? "<-- decided" : "",
            rules: l.ruleIds.length,
          })),
          ["order", "layer", "verdict", "decided", "rules"],
        )
      })
    },
  },
  {
    path: "access role list",
    summary: "The role catalogue",
    usage: "access role list [--json]",
    run: async (ctx) => {
      await withApi(ctx.profile, async (api) => {
        const roles = await api.call((c) => c.listRoles())
        printRows(
          ctx.format,
          roles.map((r) => ({
            name: r.name,
            kind: r.kind,
            managed: r.managed ? "yes" : "",
            autoAssign: r.autoAssign ? "yes" : "",
            active: r.active ? "yes" : "no",
            id: r.id,
          })),
          ["name", "kind", "managed", "autoAssign", "active", "id"],
        )
      })
    },
  },
  {
    path: "access role holders",
    summary: "Who holds a role",
    usage: "access role holders <role>",
    run: async (ctx) => {
      const [name] = ctx.args
      if (!name) throw new CliError("Which role?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        const roles = await api.call((c) => c.listRoles())
        const role = findRole(roles, name)
        const { actors } = await api.call((c) => c.roleHolders({ roleId: role.id }))
        printRows(
          ctx.format,
          actors.map((userId) => ({ role: role.name, userId })),
          ["role", "userId"],
        )
      })
    },
  },
  {
    path: "access role assign",
    summary: "Give someone a role",
    usage: "access role assign <role> <user-id>",
    run: async (ctx) => roleAssignment(ctx, "assign"),
  },
  {
    path: "access role unassign",
    summary: "Take a role away",
    usage: "access role unassign <role> <user-id>",
    run: async (ctx) => roleAssignment(ctx, "unassign"),
  },
  {
    path: "access role reorder",
    summary: "Set a member's role order — their order IS their precedence",
    usage: "access role reorder <user-id> <role> [<role> ...]",
    run: async (ctx) => {
      const [userId, ...names] = ctx.args
      if (!userId || names.length === 0) {
        throw new CliError("Need <user-id> and at least one role.", EXIT.usage)
      }
      await withApi(ctx.profile, async (api) => {
        const roles = await api.call((c) => c.listRoles())
        const roleIds = names.map((n) => findRole(roles, n).id)
        if (ctx.flags["dry-run"]) {
          note(`Would order ${userId}'s roles: ${names.join(" > ")}`)
          return
        }
        // Order is precedence since the cascade — assigning without ordering
        // cannot reproduce a member's access, which is why this command exists.
        await api.call((c) => c.reorderMemberRoles({ userId, roleIds }))
        note(`Ordered ${userId}'s roles: ${names.join(" > ")}`)
      })
    },
  },
]

const roleAssignment = async (
  ctx: { args: ReadonlyArray<string>; profile?: string; flags: Record<string, unknown> },
  verb: "assign" | "unassign",
): Promise<void> => {
  const [roleName, userId] = ctx.args
  if (!roleName || !userId) throw new CliError("Need <role> <user-id>.", EXIT.usage)
  await withApi(ctx.profile, async (api) => {
    const roles = await api.call((c) => c.listRoles())
    const role = findRole(roles, roleName)
    if (ctx.flags["dry-run"]) {
      note(`Would ${verb} "${role.name}" ${verb === "assign" ? "to" : "from"} ${userId}.`)
      return
    }
    await api.call((c) =>
      verb === "assign"
        ? c.assignRole({ roleId: role.id, userId })
        : c.unassignRole({ roleId: role.id, userId }),
    )
    note(
      `${verb === "assign" ? "Assigned" : "Unassigned"} "${role.name}" ${verb === "assign" ? "to" : "from"} ${userId}.`,
    )
  })
}
