import { ConceptService, healthCheck, PgLive } from "@kingsmaker/engine"
import { Effect } from "effect"
import { auth } from "./auth"
import { runScoped } from "./session"

const port = Number(process.env.PORT ?? 3000)

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)

    // BetterAuth's own endpoints (sign-up / sign-in / session / organization).
    if (url.pathname.startsWith("/api/auth")) return auth.handler(req)

    if (url.pathname === "/api/health") {
      const ok = await Effect.runPromise(healthCheck.pipe(Effect.provide(PgLive))).catch(
        () => false,
      )
      return Response.json({ ok }, { status: ok ? 200 : 503 })
    }

    // Example scoped read (full API arrives in Phase 3).
    if (url.pathname === "/api/concepts" && req.method === "GET") {
      const result = await runScoped(
        req,
        Effect.flatMap(ConceptService, (c) => c.list()),
      )
      return Response.json(result.ok ? result.data : { error: result.code }, {
        status: result.status,
      })
    }

    return new Response("Kingsmaker server", { status: 200 })
  },
})

console.log(`Kingsmaker server listening on http://localhost:${server.port}`)
