import { spawn } from "node:child_process"
import { CliError, EXIT } from "./errors.ts"
import { note } from "./output.ts"

/**
 * Sign in through a browser — any browser, on any machine.
 *
 * The CLI asks the deployment for a link, prints it, and waits. The person opens
 * it wherever it is convenient and signs in however this deployment allows —
 * opening the link is the approval, with nothing to type. Nothing is redirected
 * anywhere, and nothing listens on a local port.
 *
 * THAT IS THE POINT. The other standard approach — a loopback redirect — needs
 * the browser and the CLI on the same machine, so it breaks over ssh, in a
 * devcontainer, and any time you would rather open the link on your phone.
 */
interface BrowserLoginResult {
  readonly cookie: string
  readonly email: string
}

interface DeviceStart {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly intervalSeconds: number
  readonly expiresInSeconds: number
}

/** Open a URL without a dependency. Failure is fine — the URL is printed, which
 *  is what a headless or ssh session needs anyway. */
const openBrowser = (url: string): void => {
  // ALLT_NO_BROWSER exists because the end-to-end driver runs this command for
  // real, and without it every test run spawns a browser tab on whoever's
  // machine is running the suite. The URL is always printed, so suppressing the
  // launch costs nothing.
  if (process.env.ALLT_NO_BROWSER) return
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
    // Printed regardless.
  }
}

const post = async (url: string, host: string, body: unknown): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: host },
    body: JSON.stringify(body),
  }).catch((e: unknown) => {
    throw new CliError(
      `Cannot reach ${host} (${e instanceof Error ? e.message : String(e)}).`,
      EXIT.failed,
    )
  })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const browserLogin = async (host: string): Promise<BrowserLoginResult> => {
  const started = await post(`${host}/api/cli/device`, host, {})
  if (!started.ok) {
    throw new CliError(
      `This deployment does not support browser sign-in (HTTP ${started.status}).`,
      EXIT.failed,
      "It may be older than the CLI. `allt auth login --email …` still works.",
    )
  }
  const device = (await started.json()) as DeviceStart

  // On STDERR with everything else: a script capturing stdout gets data, not a
  // prompt it cannot answer.
  note("")
  note(`  Open:  ${device.verificationUri}`)
  note("")
  note("Opening your browser. Sign in there and this will continue on its own.")
  openBrowser(device.verificationUri)

  const deadline = Date.now() + device.expiresInSeconds * 1000
  let interval = Math.max(1, device.intervalSeconds) * 1000

  while (Date.now() < deadline) {
    await sleep(interval)
    const res = await post(`${host}/api/cli/device/poll`, host, { deviceCode: device.deviceCode })
    const body = (await res.json().catch(() => null)) as {
      status?: string
      cookie?: string
      userId?: string
      intervalSeconds?: number
    } | null

    if (body?.status === "approved" && body.cookie) {
      return { cookie: body.cookie, email: body.userId ?? "" }
    }
    if (body?.status === "pending") {
      // The server may ask us to back off; honour it rather than hammering.
      if (body.intervalSeconds) interval = Math.max(interval, body.intervalSeconds * 1000)
      continue
    }
    throw new CliError(
      "The sign-in request expired or was refused.",
      EXIT.unauthenticated,
      "Run `allt auth login --browser` again.",
    )
  }

  throw new CliError(
    "Timed out waiting for approval.",
    EXIT.failed,
    "Run `allt auth login --browser` again, or sign in with `--email`.",
  )
}
