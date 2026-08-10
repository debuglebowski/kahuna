# Allting

A Bun workspace. The root holds only config, the Docker/deploy files, and
`scripts/snapshot.sh` — no runtime dependencies of its own.

```
packages/app          THE DEPLOYMENT — private, never published
  engine              domain core (imported as #engine — TS source, no build step)
  db                  drizzle schema + the ONE migration set (imported as #db)
  server              Bun HTTP server: auth, RPC, SSE, integrations
  src                 React SPA
  scripts             one-off backfills + end-to-end verify drivers

packages/contract     the typed wire schema — @alltinghq/contract
packages/cli          the `allt` command line — @alltinghq/cli, published to npm
```

`#engine` / `#db` resolve through the `imports` field in
**`packages/app/package.json`** — the package that owns them, not the root, and
not tsconfig `paths`. That is what stops anything outside the deployment from
reaching the domain core or the database schema: the resolver refuses, rather
than a convention asking nicely.

**`packages/app` is deliberately ONE package.** engine, db, server and src share
a single migration baseline and one `__drizzle_migrations` ledger. Splitting them
is what `5f3b4f6` collapsed, and re-splitting reintroduces the failure where two
interleaved journals let the migrator skip a whole set and still exit 0.

**The contract is a package, not a folder.** Server, SPA and (soon) the CLI all
import `@alltinghq/contract`, so it has exactly one owner. Consumed as
TypeScript source with no build step, like `#engine`. Typechecked on its own
(`tsc -p packages/contract` runs first) so a contract error is reported against
the contract rather than whichever consumer tripped over it.

**The CLI targets NODE, not Bun.** `packages/cli` is published, so `@types/bun`
is deliberately absent from its tsconfig and nothing may reach for `Bun.*`.
TypeScript syntax that *emits* — parameter properties, enums, namespaces —
typechecks and then breaks `node --experimental-strip-types`, so `bun run
cli:build` runs in CI and the bundle is smoke-tested with plain `node`.

**Dependencies live in the package that imports them.** With real workspace
members Bun installs into `packages/<name>/node_modules` and leaves the root
nearly empty (biome + typescript). Two consequences: a phantom dependency —
imported but never declared — now fails instead of resolving through the root by
luck; and anything copying `node_modules` (the Dockerfile) must copy both trees.

## Commands

Run these from the repo root — each one `cd`s into `packages/app` where needed,
because drizzle-kit and vite both resolve paths against the CWD.

```bash
bun run dev          # vite (:5100, strict) — proxies /api to :3100
bun run serve        # the Bun server (:3100)
bun run build        # vite build -> packages/app/dist, which the server serves in prod

bun run typecheck    # tsc -p packages/contract && tsc -p packages/app
bun run check        # biome lint + format + import order (CI gate)
bun run format       # biome, writing fixes
bun run test         # vitest, whole suite (engine + server + client)

bun run db:migrate   # apply migrations  — ALWAYS use this, never drizzle push
bun run db:generate  # generate a migration from a schema change
bun run db:check     # validate snapshots + duplicate journal ids

bun run health       # DB connectivity probe
bun run seed         # seed the Allting schema into an org
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
- **`BLOB_LOCAL_DIR` is resolved against the server's CWD**, which is
  `packages/app`. A relative value therefore means `packages/app/.blobstore`, not
  the repo root — and `scripts/snapshot.sh` has to resolve it the same way or it
  silently backs up an empty directory. Set an absolute path and neither matters.
- **Uploaded blobs are NOT in `pg_dump`.** Back up the blobstore separately.
- `.env` lives at the repo root only. `packages/app/server/env.ts` loads it for
  anything running with CWD=`packages/app` (the server, vitest); it is the single
  parser. It finds the root by counting `..` from its own directory and swallows a
  miss, so a wrong depth is invisible — `server/env.test.ts` pins it.

# SlayZone Environment

You are an agent running inside a [SlayZone](https://slayzone.com) task. Other agents may be running in their own tasks in parallel, and a human or another agent can reach you through this terminal at any time.

## Interact with SlayZone

If useful, you have a toolbox for acting on SlayZone itself. You can:

- create and update tasks, and spawn sub-tasks with their own agents
- attach assets, run processes, open web panels, set up automations
- change your own task's state

The toolbox is the `slay` CLI. `$SLAYZONE_TASK_ID` holds your task's ID, and most `slay` commands default to it. **Load the `slay` skill before running any `slay` command** — it holds the full reference of commands, flags, and domain-specific guides. Never guess subcommands or flags.
