/**
 * The drizzle schema: engine tables (`schema.ts`) + BetterAuth/integration
 * tables (`auth-schema.ts`).
 *
 * `schema.ts` is DDL-only — the engine reads and writes those tables with raw
 * SQL through `@effect/sql-pg` and never imports drizzle. `auth-schema.ts` is a
 * real runtime model: `server/db.ts` hands it to drizzle, and BetterAuth's
 * `drizzleAdapter` resolves its models BY EXPORT NAME (`user`, `session`,
 * `account`, `verification`, `organization`, `member`, `invitation`), so those
 * names must not be renamed.
 *
 * Both files are re-exported here because one `drizzle.config.ts` points at this
 * directory. Their export names are disjoint. Note `schema.ts` exports a table
 * named `relations` while `auth-schema.ts` imports drizzle's `relations()`
 * helper — different scopes, no collision, but don't add a `relations` export
 * here.
 */
export * from "./auth-schema"
export * from "./schema"
