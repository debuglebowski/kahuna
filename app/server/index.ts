import "./env" // Load repo-root .env into process.env before any DB-touching import.
import path from "node:path"
import { healthCheck } from "#engine"
import { auth } from "./auth"
import { startAutomationRunner, startAutomationScheduleTick } from "./automations"
import { startDecayTick } from "./decay-tick"
import { startGoogleWatchRenewal } from "./google"
import { withApiSecurityHeaders, withAppSecurityHeaders } from "./headers"
import { handleApi } from "./router"
import { rpcHandler } from "./rpc"
import { AppRuntime } from "./runtime"
import { installGracefulShutdown } from "./shutdown"
import { startHub, streamHandler } from "./stream"
import { CURRENT_VERSION, startUpdateCheck } from "./version"

const port = Number(process.env.PORT ?? 3100)
const DIST = path.resolve(import.meta.dirname, "../dist")

// Boot the single process-wide LISTEN that powers the live-sync SSE stream,
// and the periodic decay tick that turns time-based band crossings into events.
startHub()
startDecayTick()
startGoogleWatchRenewal()
// Automations: the event-triggered runner taps the hub above (so it needs no
// second LISTEN), and the schedule tick claims due rows atomically. Both AFTER
// startHub, since the runner registers a tap on it.
startAutomationRunner()
startAutomationScheduleTick()
// Advisory-only "a newer image exists" poll. Needs no lock and no ordering
// against the above — it only writes to its own module-level memory.
startUpdateCheck()

const server = Bun.serve({
  port,
  // Must exceed the SSE heartbeat (25s in stream.ts): Bun's default 10s idle
  // kill fired BETWEEN pings and tore the live-sync stream down on a loop.
  // 60s keeps streams alive while still shedding genuinely dead connections.
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)
    // Security headers on EVERY response. `handleApi` is the one exception: the
    // attachment route needs the stricter deny-all/sandbox profile, so it sets
    // its own and is returned untouched (see `attachmentSecurityHeaders`).
    const secure = withAppSecurityHeaders

    // BetterAuth's own endpoints.
    if (url.pathname.startsWith("/api/auth")) return secure(await auth.handler(req))

    // Typed RPC endpoint (the application API).
    if (url.pathname === "/api/rpc") return secure(await rpcHandler(req))

    // Live/reactive sync: per-org SSE feed of event envelopes.
    if (url.pathname === "/api/stream") return secure(await streamHandler(req))

    if (url.pathname === "/api/health") {
      // Probe the live runtime's pool — reflects real DB health, no per-request churn.
      const ok = await AppRuntime.runPromise(healthCheck).catch(() => false)
      return secure(Response.json({ ok }, { status: ok ? 200 : 503 }))
    }

    // Application API. Gets the app profile unless the handler already set its
    // own CSP — which the attachment route does, deliberately stricter.
    const apiRes = await handleApi(req)
    if (apiRes) return withApiSecurityHeaders(apiRes)
    if (url.pathname.startsWith("/api/"))
      return secure(Response.json({ error: "NOT_FOUND" }, { status: 404 }))

    // Static SPA (built by `vite build`) with client-side-routing fallback.
    const rel = url.pathname === "/" ? "/index.html" : url.pathname
    const file = Bun.file(path.join(DIST, rel))
    if (await file.exists()) return secure(new Response(file))
    const index = Bun.file(path.join(DIST, "index.html"))
    if (await index.exists()) return secure(new Response(index))
    return secure(new Response("Kingsmaker — run `vite build` to serve the SPA.", { status: 200 }))
  },
})

installGracefulShutdown(server)

console.log(`Kingsmaker ${CURRENT_VERSION} listening on http://localhost:${server.port}`)
