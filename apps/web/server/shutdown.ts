import { pool } from "./db"
import { AppRuntime } from "./runtime"
import { closeHub } from "./stream"

/**
 * Graceful shutdown. On SIGINT/SIGTERM, stop taking new work and tear down every
 * long-lived resource in dependency order:
 *
 *   1. Close live SSE streams (clears their heartbeats) and stop the HTTP server
 *      so in-flight requests drain — SSE responses never end on their own.
 *   2. Dispose the Effect runtime: this interrupts the decay-tick + LISTEN fibers
 *      and finalizes the engine's Postgres pool + blob store.
 *   3. End BetterAuth's separate pg pool.
 *
 * A hard deadline backstops the whole sequence so a wedged step can't hang the
 * process forever.
 */

const SHUTDOWN_DEADLINE_MS = Number(process.env.SHUTDOWN_DEADLINE_MS ?? 10_000)
const STOP_GRACE_MS = Number(process.env.SHUTDOWN_STOP_GRACE_MS ?? 3_000)

let shuttingDown = false

/** Just the slice of the Bun `Server` we drive — sidesteps its WebSocket generic. */
interface StoppableServer {
  readonly stop: (closeActiveConnections?: boolean) => Promise<void>
}

/** A non-blocking timer that won't itself keep the event loop alive. */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })

export const installGracefulShutdown = (server: StoppableServer): void => {
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return // a second signal during teardown is a no-op
    shuttingDown = true
    console.log(`\n${signal} received — shutting down gracefully…`)

    // If any teardown step wedges, exit non-cleanly rather than hang forever.
    const deadline = setTimeout(() => {
      console.error(`Shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms — forcing exit.`)
      process.exit(1)
    }, SHUTDOWN_DEADLINE_MS)
    deadline.unref() // don't let the deadline itself keep the loop alive

    try {
      closeHub()
      // Let in-flight requests drain, but force-close stragglers after a short
      // grace so a lingering keep-alive can't push us to the hard deadline.
      await Promise.race([server.stop(), delay(STOP_GRACE_MS)])
      await server.stop(true)
      await AppRuntime.dispose()
      await pool.end()
      console.log("Shutdown complete.")
      process.exit(0)
    } catch (err) {
      console.error("Error during shutdown:", err)
      process.exit(1)
    }
  }

  const handle = (signal: string): void => {
    // A second signal mid-teardown means "I'm done waiting" — exit now.
    if (shuttingDown) {
      console.error(`\n${signal} again — forcing immediate exit.`)
      process.exit(1)
    }
    void shutdown(signal)
  }

  process.on("SIGINT", () => handle("SIGINT"))
  process.on("SIGTERM", () => handle("SIGTERM"))
}
