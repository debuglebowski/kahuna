# Kingsmaker

The deployment lives in `app/`; the repo root holds config, the Docker/deploy
files, and `scripts/snapshot.sh`. `packages/` holds the workspace packages —
code with consumers that do NOT ship inside the deployment.

```
app/engine            domain core (imported as #engine — TS source, no build step)
app/db                drizzle schema + the ONE migration set (imported as #db)
app/server            Bun HTTP server: auth, RPC, SSE, integrations
app/src               React SPA
app/scripts           one-off backfills + end-to-end verify drivers

packages/contract     the typed wire schema — @kingsmaker/contract
```

`#engine` / `#db` resolve through the `imports` field in the root
`package.json`, not tsconfig `paths`.

**The contract is a package, not a folder.** Server, SPA and (soon) the CLI all
import `@kingsmaker/contract`, so it has exactly one owner and the resolver — not
convention — decides who may reach it. It is consumed as TypeScript source with
no build step, like `#engine`. Typechecked on its own: `tsc -p packages/contract`
runs first in `bun run typecheck`, so a contract error is reported against the
contract rather than against whichever consumer tripped over it.

## Commands

Run these from the repo root — each one `cd`s into `app/` where needed, because
drizzle-kit and vite both resolve paths against the CWD.

```bash
bun run dev          # vite (:5100, strict) — proxies /api to :3100
bun run serve        # the Bun server (:3100)
bun run build        # vite build -> app/dist, which the server serves in prod

bun run typecheck    # tsc -p app
bun run check        # biome lint + format + import order (CI gate)
bun run format       # biome, writing fixes
bun run test         # vitest, whole suite (engine + server + client)

bun run db:migrate   # apply migrations  — ALWAYS use this, never drizzle push
bun run db:generate  # generate a migration from a schema change
bun run db:check     # validate snapshots + duplicate journal ids

bun run health       # DB connectivity probe
bun run seed         # seed the Kingsmaker schema into an org
bun run snapshot     # export/import a named dev DB + blob snapshot
```

## Things that will bite you

- **Never `drizzle-kit push`** against a real database — it drops the BetterAuth
  tables. Migrate only.
- **One migration set, one ledger.** drizzle gates on the single newest
  `created_at` in `__drizzle_migrations`, so a non-monotonic journal silently
  skips migrations and still exits 0. `server/migrations.test.ts` guards this.
- **`drizzle-kit generate` swallows exceptions and exits 0** — never trust its
  exit code; check stdout and the filesystem.
- **`BLOB_LOCAL_DIR` is resolved against the server's CWD**, which is `app/`. A
  relative value therefore means `app/.blobstore`, not the repo root.
- **Uploaded blobs are NOT in `pg_dump`.** Back up the blobstore separately.
- `.env` lives at the repo root only. `app/server/env.ts` loads it for anything
  running with CWD=`app` (the server, vitest); it is the single parser.

# SlayZone Environment

You are an agent running inside a [SlayZone](https://slayzone.com) task. Other agents may be running in their own tasks in parallel, and a human or another agent can reach you through this terminal at any time.

## Interact with SlayZone

If useful, you have a toolbox for acting on SlayZone itself. You can:

- create and update tasks, and spawn sub-tasks with their own agents
- attach assets, run processes, open web panels, set up automations
- change your own task's state

The toolbox is the `slay` CLI. `$SLAYZONE_TASK_ID` holds your task's ID, and most `slay` commands default to it. **Load the `slay` skill before running any `slay` command** — it holds the full reference of commands, flags, and domain-specific guides. Never guess subcommands or flags.
