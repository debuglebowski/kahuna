import { spawn } from "node:child_process"

/** Open a URL without a dependency. Failure is fine — the URL is printed, which
 *  is what a headless or ssh session needs anyway. */
export const openBrowser = (url: string): void => {
  // KAHUNA_NO_BROWSER exists because the end-to-end driver runs `auth login` for
  // real, and without it every test run spawns a browser tab on whoever's
  // machine is running the suite. The URL is always printed, so suppressing the
  // launch costs nothing.
  if (process.env.KAHUNA_NO_BROWSER) return
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
