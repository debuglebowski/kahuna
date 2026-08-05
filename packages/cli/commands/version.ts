import { loadConfig, resolveProfile } from "../config.ts"
import { CliError, EXIT } from "../errors.ts"
import { withVersion } from "../mutate.ts"
import { note, printRows } from "../output.ts"
import type { Command } from "../registry.ts"
import { type Api, makeRuntime } from "../transport.ts"

/**
 * Draft → published, for concepts with versioning switched on.
 *
 * `listVersions` takes a RECORD id (the lineage); `publishVersion` and
 * `discardDraft` take a VERSION id. The rename made that distinction visible in
 * the names, so the commands keep it visible in their arguments too.
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

/** A version id addresses one version; a record id addresses the lineage. */
const recordIdOf = async (api: Api, id: string): Promise<string> => {
  const detail = await api.call((c) => c.getRecord({ id })).catch(() => null)
  return detail ? detail.recordVersion.recordId : id
}

export const versionCommands: ReadonlyArray<Command> = [
  {
    path: "record version list",
    summary: "The version lineage of one record",
    usage: "record version list <record-id | version-id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which record?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        const recordId = await recordIdOf(api, id)
        const versions = await api.call((c) => c.listVersions({ recordId }))
        printRows(
          ctx.format,
          versions.map((v) => ({
            id: v.id,
            seq: v.versionSeq,
            status: v.versionStatus,
            published: v.publishedAt ?? "",
            created: v.createdAt,
          })),
          ["id", "seq", "status", "published", "created"],
        )
      })
    },
  },
  {
    path: "record version create",
    summary: "Open a new draft cloned from the record",
    usage: "record version create <record-id | version-id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which record?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        const recordId = await recordIdOf(api, id)
        if (ctx.flags["dry-run"]) {
          note(`Would open a new draft on ${recordId}.`)
          return
        }
        const draft = await api.call((c) => c.newVersion({ recordId }))
        note(`Opened draft ${draft.id} (v${draft.versionSeq}).`)
      })
    },
  },
  {
    path: "record version publish",
    summary: "Freeze a draft — permanent",
    usage: "record version publish <version-id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which version?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would publish version ${id}. Publishing is permanent.`)
          return
        }
        const published = await withVersion(
          async () => (await api.call((c) => c.getRecord({ id }))).recordVersion,
          (current) => api.call((c) => c.publishVersion({ id, expectedVersion: current.version })),
        )
        note(`Published v${published.versionSeq} (${published.id}).`)
      })
    },
  },
  {
    path: "record version discard",
    summary: "Throw away an unpublished draft",
    usage: "record version discard <version-id>",
    run: async (ctx) => {
      const [id] = ctx.args
      if (!id) throw new CliError("Which version?", EXIT.usage)
      await withApi(ctx.profile, async (api) => {
        if (ctx.flags["dry-run"]) {
          note(`Would discard draft ${id}.`)
          return
        }
        await api.call((c) => c.discardDraft({ id }))
        note(`Discarded draft ${id}.`)
      })
    },
  },
]
