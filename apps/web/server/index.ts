import { healthCheck, PgLive } from "@kingsmaker/engine"
import { Effect } from "effect"

const port = Number(process.env.PORT ?? 3000)

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/api/health") {
      const ok = await Effect.runPromise(healthCheck.pipe(Effect.provide(PgLive))).catch(
        () => false,
      )
      return Response.json({ ok }, { status: ok ? 200 : 503 })
    }

    return new Response("Kingsmaker server", { status: 200 })
  },
})

console.log(`Kingsmaker server listening on http://localhost:${server.port}`)
