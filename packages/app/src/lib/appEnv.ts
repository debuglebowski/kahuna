/**
 * Which environment is this build, and how the shell says so.
 *
 * `import.meta.env.DEV` is the signal deliberately. Vite replaces it with a
 * literal at BUILD time, so the production bundle — the only thing the Docker
 * image ever serves — carries `false`, and no stray env var, proxy header or
 * hostname can flip it back on at runtime. That asymmetry is the point: a "dev"
 * marker that can appear on the live deployment is worse than none at all,
 * because it is the direction that makes someone careless with real data.
 *
 * The converse gap is accepted: `bun run build && bun run serve` locally shows
 * no marker. That IS a production bundle; it just happens to point at a dev
 * database. Do not "fix" it with a `localhost` hostname check — that check
 * fires for anyone reaching the live app through a tunnel or a port-forward,
 * which is exactly the false positive this trades away.
 */
export const IS_DEV = Boolean(import.meta.env.DEV)

/** The product wordmark, unqualified. */
export const APP_NAME = "Kingsmaker"

/**
 * The browser tab title. index.html carries the plain name as its pre-boot
 * value (correct for production); main.tsx overwrites it from here once the app
 * mounts, so dev and prod have one definition rather than two that can drift.
 */
export const APP_TITLE = IS_DEV ? `${APP_NAME} (dev)` : APP_NAME
