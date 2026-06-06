import path from "node:path"
import { healthCheck, PgLive } from "@kingsmaker/engine"
import { Effect } from "effect"
import { auth } from "./auth"
import { handleApi } from "./router"

const port = Number(process.env.PORT ?? 3000)
const DIST = path.resolve(import.meta.dirname, "../dist")

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)

    // BetterAuth's own endpoints.
    if (url.pathname.startsWith("/api/auth")) return auth.handler(req)

    if (url.pathname === "/api/health") {
      const ok = await Effect.runPromise(healthCheck.pipe(Effect.provide(PgLive))).catch(
        () => false,
      )
      return Response.json({ ok }, { status: ok ? 200 : 503 })
    }

    // Application API.
    const apiRes = await handleApi(req)
    if (apiRes) return apiRes
    if (url.pathname.startsWith("/api/"))
      return Response.json({ error: "NOT_FOUND" }, { status: 404 })

    // Static SPA (built by `vite build`) with client-side-routing fallback.
    const rel = url.pathname === "/" ? "/index.html" : url.pathname
    const file = Bun.file(path.join(DIST, rel))
    if (await file.exists()) return new Response(file)
    const index = Bun.file(path.join(DIST, "index.html"))
    if (await index.exists()) return new Response(index)
    return new Response("Kingsmaker — run `vite build` to serve the SPA.", { status: 200 })
  },
})

console.log(`Kingsmaker server listening on http://localhost:${server.port}`)
