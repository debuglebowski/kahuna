import { requireSession } from "../config.ts"
import { CliError, EXIT, exitCodeForStatus } from "../errors.ts"
import { note, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Members of the one organization this deployment has.
 *
 * `add` and `update` are plain HTTP, not RPC: BetterAuth owns the membership
 * tables and the server wraps them at `/api/org/*` precisely because
 * BetterAuth's own endpoints decide from the membership TIER, which an
 * administrator no longer has (see router.ts).
 */
const withApi = async <T>(f: (api: Api) => Promise<T>): Promise<T> => {
  const api = makeRuntime(requireSession())
  try {
    return await f(api)
  } finally {
    await api.dispose()
  }
}

const post = async (path: string, body?: unknown, method = "POST"): Promise<unknown> => {
  const session = requireSession()
  const res = await fetch(`${session.host}${path}`, {
    method,
    // The session cookie is attached by hand: never follow a redirect with it.
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      cookie: session.cookie ?? "",
      origin: session.host,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((e: unknown) => {
    throw new CliError(
      `Cannot reach ${session.host} (${e instanceof Error ? e.message : String(e)}).`,
      EXIT.failed,
    )
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null
    throw new CliError(
      payload?.error ?? `Request failed (HTTP ${res.status}).`,
      exitCodeForStatus(res.status),
    )
  }
  return res.json().catch(() => ({}))
}

export const organizationCommands: ReadonlyArray<Command> = [
  {
    path: "organization member list",
    summary: "Everyone in the organization, with their roles",
    usage: "organization member list [--json]",
    run: async (ctx) => {
      await withApi(async (api) => {
        // There is no "list members" RPC — membership lives in BetterAuth's
        // tables. Role holders plus the deactivation list is what the API can
        // actually answer, so build the roster from those rather than inventing
        // a source of truth the server does not have.
        const roles = await api.call((c) => c.listRoles())
        const deactivated = await api.call((c) => c.listDeactivatedMembers())
        const byUser = new Map<string, Array<string>>()
        for (const role of roles) {
          const { actors } = await api.call((c) => c.roleHolders({ roleId: role.id }))
          for (const userId of actors) {
            const list = byUser.get(userId) ?? []
            list.push(role.name)
            byUser.set(userId, list)
          }
        }
        const off = new Set(deactivated.map((d) => d.userId))
        for (const d of deactivated) if (!byUser.has(d.userId)) byUser.set(d.userId, [])
        printRows(
          ctx.format,
          [...byUser].map(([userId, names]) => ({
            userId,
            roles: names.join(", "),
            active: off.has(userId) ? "no" : "yes",
          })),
          ["userId", "roles", "active"],
        )
      })
    },
  },
  {
    path: "organization member add",
    summary: "Add an existing account to the organization by email",
    usage: "organization member add <email>",
    run: async (ctx) => {
      const [email] = ctx.args
      if (!email) throw new CliError("An email address is required.", EXIT.usage)
      if (ctx.flags["dry-run"]) {
        note(`Would add ${email} to the organization.`)
        return
      }
      // The account must already exist: self-serve sign-up is closed, so an
      // operator provisions it first (scripts/create-user.ts). Say that when the
      // server reports no such user, rather than leaving "NO_SUCH_USER" bare.
      try {
        await post("/api/org/members", { email })
      } catch (e) {
        if ((e as CliError).message === "NO_SUCH_USER") {
          throw new CliError(
            `No account for ${email}.`,
            EXIT.notFound,
            "Sign-up is closed, so the account must be provisioned first: `bun scripts/create-user.ts <email> <password>` on the server.",
          )
        }
        throw e
      }
      note(`Added ${email}.`)
    },
  },
  {
    path: "organization member deactivate",
    summary: "Block a member without deleting anything",
    usage: "organization member deactivate <user-id>",
    run: async (ctx) => memberState(ctx, "deactivate"),
  },
  {
    path: "organization member reactivate",
    summary: "Let a deactivated member back in",
    usage: "organization member reactivate <user-id>",
    run: async (ctx) => memberState(ctx, "reactivate"),
  },
]

const memberState = async (
  ctx: { args: ReadonlyArray<string>; flags: Record<string, unknown> },
  verb: "deactivate" | "reactivate",
): Promise<void> => {
  const [userId] = ctx.args
  if (!userId) throw new CliError("Which member?", EXIT.usage)
  await withApi(async (api) => {
    if (ctx.flags["dry-run"]) {
      note(`Would ${verb} ${userId}.`)
      return
    }
    await api.call((c) =>
      verb === "deactivate" ? c.deactivateMember({ userId }) : c.reactivateMember({ userId }),
    )
    note(`${verb === "deactivate" ? "Deactivated" : "Reactivated"} ${userId}.`)
  })
}
