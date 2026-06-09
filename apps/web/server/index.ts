import "./env" // Load repo-root .env into process.env before any DB-touching import.
import path from "node:path"
import { healthCheck } from "@kingsmaker/engine"
import { auth } from "./auth"
import { startDecayTick } from "./decay-tick"
import { handleApi } from "./router"
import { rpcHandler } from "./rpc"
import { AppRuntime } from "./runtime"
import { installGracefulShutdown } from "./shutdown"
import { startHub, streamHandler } from "./stream"

const port = Number(process.env.PORT ?? 3000)
const DIST = path.resolve(import.meta.dirname, "../dist")

// Boot the single process-wide LISTEN that powers the live-sync SSE stream,
// and the periodic decay tick that turns time-based band crossings into events.
startHub()
startDecayTick()

const server = Bun.serve({
  port,
  // Must exceed the SSE heartbeat (25s in stream.ts): Bun's default 10s idle
  // kill fired BETWEEN pings and tore the live-sync stream down on a loop.
  // 60s keeps streams alive while still shedding genuinely dead connections.
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)

    // BetterAuth's own endpoints.
    if (url.pathname.startsWith("/api/auth")) return auth.handler(req)

    // Typed RPC endpoint (the application API).
    if (url.pathname === "/api/rpc") return rpcHandler(req)

    // Live/reactive sync: per-org SSE feed of event envelopes.
    if (url.pathname === "/api/stream") return streamHandler(req)

    if (url.pathname === "/api/health") {
      // Probe the live runtime's pool — reflects real DB health, no per-request churn.
      const ok = await AppRuntime.runPromise(healthCheck).catch(() => false)
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

installGracefulShutdown(server)

console.log(`Kingsmaker server listening on http://localhost:${server.port}`)
