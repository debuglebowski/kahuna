import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { CliError, EXIT } from "./errors.ts"
import { note } from "./output.ts"

/**
 * Sign in through the browser, for the methods a CLI cannot drive itself.
 *
 * The person signs in normally — password, SSO, whatever this deployment
 * allows — and the server hands the credential to a listener on 127.0.0.1. The
 * CLI never sees the identity provider, which is exactly why this works where a
 * CLI-driven SSO flow cannot.
 *
 * Bound to 127.0.0.1 rather than 0.0.0.0: on a shared or untrusted network,
 * listening on every interface would offer the callback — and with it the
 * credential — to anyone who could guess the port.
 */
const TIMEOUT_MS = 3 * 60_000

interface BrowserLoginResult {
  readonly cookie: string
  readonly email: string
}

const page = (title: string, message: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title>` +
  `<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:24px;color:#15181d;background:#f1f2f5}` +
  `main{max-width:30rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#4b525d}` +
  `@media(prefers-color-scheme:dark){body{background:#0f1216;color:#e8ebf0}p{color:#a7afbb}}</style>` +
  `<main><h1>${title}</h1><p>${message}</p></main>`

/** Open a URL in the platform's browser, without a dependency. Failure is not
 *  fatal: the URL is printed either way, which is what a headless or ssh
 *  session needs anyway. */
const openBrowser = (url: string): void => {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    })
    child.on("error", () => undefined)
    child.unref()
  } catch {
    // Printed below regardless.
  }
}

export const browserLogin = async (host: string): Promise<BrowserLoginResult> => {
  // Proves the callback belongs to THIS invocation. Without it, anything that
  // could reach the loopback port could feed us a code from another flow.
  const state = randomBytes(24).toString("base64url")

  const received = await new Promise<{ code: string; state: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (url.pathname !== "/callback") {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get("error")
      const code = url.searchParams.get("code")
      const returned = url.searchParams.get("state")

      // Answer the browser BEFORE resolving, so the person sees the outcome
      // rather than a hung tab while the CLI moves on.
      res.writeHead(error || !code ? 400 : 200, { "content-type": "text/html; charset=utf-8" })
      res.end(
        error || !code
          ? page("Sign-in failed", "Return to the terminal — it has the details.")
          : page("Signed in", "You can close this tab and return to the terminal."),
      )

      server.close()
      if (error) reject(new CliError(`Sign-in failed: ${error}`, EXIT.unauthenticated))
      else if (!code || !returned)
        reject(new CliError("The callback carried no code.", EXIT.failed))
      else resolve({ code, state: returned })
    })

    server.on("error", (e) =>
      reject(new CliError(`Cannot listen on 127.0.0.1 (${e.message}).`, EXIT.failed)),
    )

    // Port 0 = let the OS pick a free one; nothing is reserved or guessable.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      const authorize = `${host}/api/cli/authorize?port=${port}&state=${encodeURIComponent(state)}`
      note("Opening your browser to sign in.")
      note(`If it does not open, visit:\n  ${authorize}`)
      openBrowser(authorize)
    })

    const timer = setTimeout(() => {
      server.close()
      reject(
        new CliError(
          "Timed out waiting for the browser.",
          EXIT.failed,
          "Re-run `km auth login --browser`, or use email and password.",
        ),
      )
    }, TIMEOUT_MS)
    // Do not hold the process open on the timer alone.
    timer.unref?.()
  })

  if (received.state !== state) {
    // Someone answered our callback with a code from a different flow.
    throw new CliError("The browser returned a mismatched state.", EXIT.failed)
  }

  const res = await fetch(`${host}/api/cli/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: host },
    body: JSON.stringify({ code: received.code, state }),
  }).catch((e: unknown) => {
    throw new CliError(
      `Cannot reach ${host} (${e instanceof Error ? e.message : String(e)}).`,
      EXIT.failed,
    )
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new CliError(
      body?.error ?? `Could not exchange the code (HTTP ${res.status}).`,
      EXIT.unauthenticated,
      body?.error === "UNKNOWN_OR_EXPIRED_CODE"
        ? "Codes last 60 seconds. Re-run the command and finish signing in promptly."
        : undefined,
    )
  }

  const payload = (await res.json()) as { cookie?: string; userId?: string }
  if (!payload.cookie) throw new CliError("The server returned no credential.", EXIT.failed)
  return { cookie: payload.cookie, email: payload.userId ?? "" }
}
