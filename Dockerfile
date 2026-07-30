# syntax=docker/dockerfile:1

# Kingsmaker — single-process image: Bun serves auth + RPC + SSE + the built SPA.
#
# The engine (`apps/web/engine`) has NO build step: it's consumed as TypeScript
# source through the `#engine` subpath import, so the runtime ships Bun + the TS
# sources rather than a compiled artifact.
#
# Three stages. `build` does a full install and runs Vite. `prod-deps` does a
# separate --production install, because a full node_modules is ~580MB and most
# of it is build/lint tooling the runtime never loads (biome alone is 95MB across
# two platform binaries, plus typescript and rolldown). `drizzle-kit` is the one
# devDependency the runtime genuinely needs — it's the migrate entrypoint — so it
# gets copied back in explicitly.

# ---- deps + build ----------------------------------------------------------
FROM oven/bun:1.3.6-alpine AS build

WORKDIR /app

# Manifests first so `bun install` caches independently of source edits.
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/

RUN bun install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json biome.json ./
COPY apps/web ./apps/web

# Emits apps/web/dist, which server/index.ts resolves as `../dist`.
RUN bun run --filter @kingsmaker/web build

# ---- production dependencies ----------------------------------------------
FROM oven/bun:1.3.6-alpine AS prod-deps

WORKDIR /app

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/

RUN bun install --frozen-lockfile --production

# ---- runtime ---------------------------------------------------------------
FROM oven/bun:1.3.6-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3100 \
    # Absolute, and outside the source tree: BLOB_LOCAL_DIR is resolved relative
    # to the process CWD, so a relative default would silently follow whatever
    # directory the process was launched from. Mount a volume here.
    BLOB_LOCAL_DIR=/data/blobstore

# tini reaps zombies and forwards SIGTERM to Bun, which the server needs: it
# installs its own graceful-shutdown handler with a 10s internal deadline.
RUN apk add --no-cache tini

COPY --from=prod-deps /app/node_modules ./node_modules
# drizzle-kit is a devDependency but `migrate` needs it. Bun's isolated layout
# keeps the real package in node_modules/.bun and symlinks to it per workspace,
# so copy the store entry (self-contained, ~10MB — it bundles its own
# esbuild/tsx) and re-create the links below.
COPY --from=build /app/node_modules/.bun/drizzle-kit@0.31.10 ./node_modules/.bun/drizzle-kit@0.31.10
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/tsconfig.base.json /app/tsconfig.json ./

COPY --from=prod-deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/web/package.json ./apps/web/
COPY --from=build /app/apps/web/tsconfig.json ./apps/web/
COPY --from=build /app/apps/web/drizzle.config.ts ./apps/web/

# Re-create the drizzle-kit links the --production install omitted, pointing at
# the store entry copied above. apps/web is the only workspace now.
#
# The `.bin` entry matters as much as the package link: without a local .bin,
# `bunx drizzle-kit` silently falls back to DOWNLOADING drizzle-kit at runtime
# (and then fails on a drizzle-orm version mismatch). A migrate command must
# never depend on network access, so both are created explicitly and asserted.
RUN set -eux; \
    mkdir -p apps/web/node_modules/.bin; \
    ln -sfn ../../../node_modules/.bun/drizzle-kit@0.31.10/node_modules/drizzle-kit \
      apps/web/node_modules/drizzle-kit; \
    ln -sfn ../../../../node_modules/.bun/drizzle-kit@0.31.10/node_modules/.bin/drizzle-kit \
      apps/web/node_modules/.bin/drizzle-kit; \
    test -e apps/web/node_modules/drizzle-kit/package.json; \
    test -x apps/web/node_modules/.bin/drizzle-kit

# `engine/` is the domain core (TS source, imported as `#engine`); `db/` holds the
# drizzle schema AND the migrations that `migrate` applies; `rpc/` holds the RPC
# contract that server/rpc.ts imports as `../rpc/contract`.
COPY --from=build /app/apps/web/engine ./apps/web/engine
COPY --from=build /app/apps/web/db ./apps/web/db
COPY --from=build /app/apps/web/rpc ./apps/web/rpc
COPY --from=build /app/apps/web/server ./apps/web/server
COPY --from=build /app/apps/web/scripts ./apps/web/scripts
COPY --from=build /app/apps/web/dist ./apps/web/dist

# A .dockerignore slip or a bad COPY would otherwise surface as `migrate` cheerily
# applying zero migrations at deploy time. Fail the build instead.
RUN test -f apps/web/db/migrations/0000_baseline.sql \
    && test -f apps/web/db/migrations/meta/_journal.json \
    && test -f apps/web/engine/index.ts

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

# `serve` is the default; `migrate` applies both migration sets and exits.
# Migration is deliberately NOT part of startup — see docker-entrypoint.sh.
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["serve"]
