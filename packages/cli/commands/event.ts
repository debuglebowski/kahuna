import { loadConfig, resolveProfile } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { note, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { conceptContext } from "../resolve.ts"
import { makeRuntime } from "../transport.ts"

/**
 * The event log — the audit trail.
 *
 * `listEvents` filters by CONCEPT and time, and has no per-record filter, so
 * `--record` narrows client-side over the window the server returned. That is a
 * real limitation, not a detail: a busy concept can push a given record's events
 * out of the window entirely, so say so rather than presenting a short list as
 * the whole truth.
 */
export const eventCommands: ReadonlyArray<Command> = [
  {
    path: "record event list",
    summary: "Recent events, by concept and time window",
    usage: "record event list [--concept <name>] [--record <id>] [--since <iso|days>] [--limit n]",
    options: {
      concept: { type: "string" },
      record: { type: "string" },
      since: { type: "string" },
      limit: { type: "string" },
    },
    run: async (ctx) => {
      const { profile } = resolveProfile(loadConfig(), ctx.profile)
      const api = makeRuntime(profile)
      try {
        const conceptName = ctx.flags.concept as string | undefined
        const conceptId = conceptName
          ? (await conceptContext(api, conceptName)).concept.id
          : undefined

        const limit = ctx.flags.limit ? Number(ctx.flags.limit) : undefined
        if (limit !== undefined && Number.isNaN(limit)) {
          throw new CliError("--limit needs a number.", EXIT.usage)
        }

        const events = await api.call((c) =>
          c.listEvents({
            conceptId,
            since: parseSince(ctx.flags.since as string | undefined),
            limit,
          }),
        )

        const recordId = ctx.flags.record as string | undefined
        const rows = (recordId
          ? events.filter((e) => JSON.stringify(e).includes(recordId))
          : events) as unknown as ReadonlyArray<Record<string, unknown>>

        if (recordId && events.length > 0 && rows.length === 0) {
          note(
            `No events for ${recordId} in the window the server returned (${events.length} events).` +
              " listEvents has no per-record filter, so widen --since or raise --limit.",
          )
        }
        printRows(ctx.format, rows)
      } finally {
        await api.dispose()
      }
    },
  },
]

/** `--since` accepts an ISO date or a plain day count; the API wants epoch ms. */
const parseSince = (since: string | undefined): number | undefined => {
  if (!since) return undefined
  const days = Number(since)
  if (!Number.isNaN(days)) return Date.now() - days * 24 * 60 * 60 * 1000
  const at = Date.parse(since)
  if (Number.isNaN(at)) {
    throw new CliError(
      `"${since}" is neither a date nor a number of days.`,
      EXIT.usage,
      "Try --since 7 (days) or --since 2026-08-01.",
    )
  }
  return at
}
