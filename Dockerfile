# syntax=docker/dockerfile:1

# Kahuna — single-process image: Bun serves auth + RPC + SSE + the built SPA.
#
# The engine (`packages/app/engine`) has NO build step: it's consumed as TypeScript
# source through the `#engine` subpath import, so the runtime ships Bun + the TS
# sources rather than a compiled artifact.
#
# Three stages. `build` does a full install and runs Vite. `prod-deps` does a
# separate --production install, because a full node_modules is ~580MB and most
# of it is build/lint tooling the runtime never loads (biome alone is 95MB across
# two platform binaries, plus typescript and rolldown).
#
# `drizzle-kit` is a runtime `dependency`, not a devDependency: it IS the migrate
# entrypoint. It used to be a devDependency copied back in by hand from Bun's
# isolated store, which worked only because the workspace layout nested
# drizzle-kit's own esbuild/tsx inside the store entry. With one manifest the
# install is flat, those deps hoist to siblings, and copying the package alone
# fails at runtime with `Cannot find module 'esbuild'`. Declaring it costs ~40MB
# in the runtime image and buys a migrate path that cannot silently reach for the
# network.

# ---- deps + build ----------------------------------------------------------
FROM oven/bun:1.3.6-alpine AS build

WORKDIR /srv/kahuna

# THE WHOLE `packages` TREE, not a hand-listed set of manifests.
#
# This used to copy each workspace member's package.json by name, so that
# `bun install` cached independently of source edits. That list rotted the first
# time a package was added: `workspaces: ["packages/*"]` resolves every member,
# a missing one makes the resolved set differ from the lockfile, and
# `--frozen-lockfile` fails with "lockfile had changes" — pointing at the
# install, not at the COPY that caused it.
#
# A list that must be updated by hand, in a file nobody edits when adding a
# package, is a trap regardless of how loudly its comment warns. Copying the
# tree cannot go stale; the cost is that a source edit re-runs an install that
# takes about two seconds.
COPY package.json bun.lock ./
COPY packages ./packages

RUN bun install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json biome.json ./

# Emits packages/app/dist, which server/index.ts resolves as `../dist`.
RUN bun run build

# ---- production dependencies ----------------------------------------------
FROM oven/bun:1.3.6-alpine AS prod-deps

WORKDIR /srv/kahuna

# Same reasoning as the build stage: the tree, not a list.
COPY package.json bun.lock ./
COPY packages ./packages

RUN bun install --frozen-lockfile --production

# ---- runtime ---------------------------------------------------------------
FROM oven/bun:1.3.6-alpine AS runtime

WORKDIR /srv/kahuna

# What build is this? Passed by CI from the git tag / ref. Without it the server
# reports `dev` and never claims an update is available — a source checkout has
# no version to compare against. Declared AFTER the build stages on purpose: a
# version bump must not invalidate the `bun install` or `vite build` cache.
ARG KAHUNA_VERSION=dev
LABEL org.opencontainers.image.version="${KAHUNA_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/debuglebowski/kahuna"

ENV NODE_ENV=production \
    PORT=3100 \
    # Read by server/version.ts and reported at /api/version.
    KAHUNA_VERSION=${KAHUNA_VERSION} \
    # Absolute, and outside the source tree: BLOB_LOCAL_DIR is resolved relative
    # to the process CWD, so a relative default would silently follow whatever
    # directory the process was launched from. Mount a volume here.
    BLOB_LOCAL_DIR=/data/blobstore

# tini reaps zombies and forwards SIGTERM to Bun, which the server needs: it
# installs its own graceful-shutdown handler with a 10s internal deadline.
RUN apk add --no-cache tini

# BOTH trees. With real workspace members Bun installs each member's
# dependencies into ITS OWN node_modules and leaves the root nearly empty (2
# entries: biome + typescript, the tooling the root scripts run). Copying only
# the root, as this did when the repo had a single manifest, produces an image
# whose every runtime dependency is missing.
COPY --from=prod-deps /srv/kahuna/node_modules ./node_modules
COPY --from=prod-deps /srv/kahuna/packages/app/node_modules ./packages/app/node_modules
# `packages/app/package.json` carries the `imports` map (#engine, #db) that every
# server module resolves through, so it is required at RUNTIME, not just at build
# time. The root manifest comes too: it defines the workspace the node_modules
# symlinks were built against.
COPY --from=build /srv/kahuna/package.json /srv/kahuna/bun.lock ./
COPY --from=build /srv/kahuna/tsconfig.base.json /srv/kahuna/tsconfig.json ./
COPY --from=build /srv/kahuna/packages/app/package.json ./packages/app/
COPY --from=build /srv/kahuna/packages/app/tsconfig.json ./packages/app/
COPY --from=build /srv/kahuna/packages/app/drizzle.config.ts ./packages/app/

# `engine/` is the domain core (TS source, imported as `#engine`); `db/` holds the
# drizzle schema AND the migrations that `migrate` applies.
#
# `packages/contract` is the RPC contract, imported as `@kahunalabs/contract`. It
# is resolved through a node_modules SYMLINK that `bun install` created in the
# prod-deps stage pointing at `../../packages/contract` — so the directory must
# land at exactly that path or every server module fails to import at boot.
COPY --from=build /srv/kahuna/packages/contract ./packages/contract
COPY --from=build /srv/kahuna/packages/app/engine ./packages/app/engine
COPY --from=build /srv/kahuna/packages/app/db ./packages/app/db
COPY --from=build /srv/kahuna/packages/app/server ./packages/app/server
COPY --from=build /srv/kahuna/packages/app/scripts ./packages/app/scripts
COPY --from=build /srv/kahuna/packages/app/dist ./packages/app/dist

# The automation runner evaluates conditions with the SAME matcher the client
# filters with (`server/automations.ts` -> `../src/lib/conditions`), so these two
# client modules are runtime server code despite living under src/. Both are pure
# (no React/DOM) and `conditions`' only other runtime import is
# `@kahunalabs/contract`, copied above — its `./api` import is type-only and erases.
#
# Without them the server does not boot AT ALL: `Cannot find module
# '../src/lib/conditions'`, thrown at import time before anything listens.
COPY --from=build /srv/kahuna/packages/app/src/lib/conditions.ts ./packages/app/src/lib/
COPY --from=build /srv/kahuna/packages/app/src/lib/richtext.ts ./packages/app/src/lib/

# A .dockerignore slip or a bad COPY would otherwise surface as `migrate` cheerily
# applying zero migrations at deploy time. Fail the build instead.
RUN test -f packages/app/db/migrations/0000_baseline.sql \
    && test -f packages/app/db/migrations/meta/_journal.json \
    && test -f packages/app/engine/index.ts

# `bunx drizzle-kit` runs with CWD=packages/app and resolves from that package's
# own node_modules. Assert it rather than trust it: with no local binary, bunx
# silently falls back to DOWNLOADING drizzle-kit at runtime (and then fails on a
# drizzle-orm version mismatch). A migrate command must never depend on network
# access.
#
# PLACED AFTER the source COPYs on purpose: `@kahunalabs/contract` is a symlink
# into `packages/contract`, so resolving it earlier tests a link whose target has
# not been copied yet and fails on an image that is fine.
#
# RUN IT, don't stat it. The old assertion tested for `node_modules/esbuild` —
# drizzle-kit's own runtime dependency — as a sibling, which is where a flat
# single-manifest install put it. A workspace install is isolated: packages are
# symlinks into the ROOT `node_modules/.bun` store, and esbuild resolves through
# drizzle-kit's own nested tree, so the path test failed on an image that was
# actually fine. `--version` loads the binary and its dependencies without
# touching a database or reading drizzle.config.ts, so it proves the thing the
# path test was only guessing at.
RUN set -eux; \
    test -x packages/app/node_modules/.bin/drizzle-kit; \
    test -e packages/app/node_modules/@kahunalabs/contract/contract.ts; \
    cd packages/app && ./node_modules/.bin/drizzle-kit --version


# The checks above are per-file and so only catch omissions someone thought to
# list. This catches the general case: resolve every FIRST-PARTY import the
# server reaches, and fail the build if one is missing. It exists because
# server/automations.ts imports `../src/lib/conditions` — client-tree code that
# no COPY brought in — and the resulting image could not boot at all.
#
# Deliberately a resolver walk over our own files, not `bun build`: bundling
# descends into node_modules and trips over a benign export mismatch inside
# @better-auth/kysely-adapter, on a dialect Bun never loads. And not `bun -e
# 'import(...)'` either — importing server/index.ts EXECUTES it (it opens a DB
# pool and starts listening at import time), which is not something a build stage
# should do.
COPY packages/app/scripts/check-image-imports.ts ./packages/app/scripts/
RUN cd packages/app && bun scripts/check-image-imports.ts server/index.ts scripts/bootstrap.ts

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data/blobstore \
    && chown -R bun:bun /data

USER bun

# Declared so a bare `docker run` still gets an anonymous volume rather than
# writing uploads into the container layer, where removal destroys them.
# Blobs live ONLY here — pg_dump does not back them up. Mount something durable.
VOLUME ["/data"]

EXPOSE 3100

# `serve` is the default; `migrate` applies the migrations and exits.
# Migration is deliberately NOT part of startup — see docker-entrypoint.sh.
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["serve"]
