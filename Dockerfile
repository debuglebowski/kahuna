# syntax=docker/dockerfile:1

# Kingsmaker — single-process image: Bun serves auth + RPC + SSE + the built SPA.
#
# The engine (`app/engine`) has NO build step: it's consumed as TypeScript
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

WORKDIR /srv/kingsmaker

# Manifest first so `bun install` caches independently of source edits.
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json biome.json ./
COPY app ./app

# Emits app/dist, which server/index.ts resolves as `../dist`.
RUN bun run build

# ---- production dependencies ----------------------------------------------
FROM oven/bun:1.3.6-alpine AS prod-deps

WORKDIR /srv/kingsmaker

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production

# ---- runtime ---------------------------------------------------------------
FROM oven/bun:1.3.6-alpine AS runtime

WORKDIR /srv/kingsmaker

ENV NODE_ENV=production \
    PORT=3100 \
    # Absolute, and outside the source tree: BLOB_LOCAL_DIR is resolved relative
    # to the process CWD, so a relative default would silently follow whatever
    # directory the process was launched from. Mount a volume here.
    BLOB_LOCAL_DIR=/data/blobstore

# tini reaps zombies and forwards SIGTERM to Bun, which the server needs: it
# installs its own graceful-shutdown handler with a 10s internal deadline.
RUN apk add --no-cache tini

COPY --from=prod-deps /srv/kingsmaker/node_modules ./node_modules
# The root manifest carries the `imports` map (#engine, #db) that every server
# module resolves through, so it is required at runtime, not just at build time.
COPY --from=build /srv/kingsmaker/package.json /srv/kingsmaker/bun.lock ./
COPY --from=build /srv/kingsmaker/tsconfig.base.json /srv/kingsmaker/tsconfig.json ./
COPY --from=build /srv/kingsmaker/app/tsconfig.json ./app/
COPY --from=build /srv/kingsmaker/app/drizzle.config.ts ./app/

# `bunx drizzle-kit` resolves upward from app/ into the root node_modules/.bin.
# Assert it rather than trust it: with no local binary, bunx silently falls back
# to DOWNLOADING drizzle-kit at runtime (and then fails on a drizzle-orm version
# mismatch). A migrate command must never depend on network access.
RUN set -eux; \
    test -x node_modules/.bin/drizzle-kit; \
    test -e node_modules/drizzle-kit/package.json; \
    test -e node_modules/esbuild/package.json

# `engine/` is the domain core (TS source, imported as `#engine`); `db/` holds the
# drizzle schema AND the migrations that `migrate` applies; `rpc/` holds the RPC
# contract that server/rpc.ts imports as `../rpc/contract`.
COPY --from=build /srv/kingsmaker/app/engine ./app/engine
COPY --from=build /srv/kingsmaker/app/db ./app/db
COPY --from=build /srv/kingsmaker/app/rpc ./app/rpc
COPY --from=build /srv/kingsmaker/app/server ./app/server
COPY --from=build /srv/kingsmaker/app/scripts ./app/scripts
COPY --from=build /srv/kingsmaker/app/dist ./app/dist

# A .dockerignore slip or a bad COPY would otherwise surface as `migrate` cheerily
# applying zero migrations at deploy time. Fail the build instead.
RUN test -f app/db/migrations/0000_baseline.sql \
    && test -f app/db/migrations/meta/_journal.json \
    && test -f app/engine/index.ts

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
