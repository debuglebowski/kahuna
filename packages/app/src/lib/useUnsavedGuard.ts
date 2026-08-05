import { useEffect, useRef } from "react"
import { useBlocker } from "react-router-dom"

/**
 * Guards a dirty full-page editor against losing unsaved edits. Blocks in-app
 * navigation (sidebar clicks, breadcrumb/Cancel, back/forward) via the router's
 * {@link useBlocker} — render a confirm when `blocker.state === "blocked"`, then
 * call `blocker.proceed()` / `blocker.reset()`. Also arms the native
 * `beforeunload` prompt so reload/tab-close are caught too.
 *
 * After a successful save/delete, call `bypass()` immediately before navigating
 * so the programmatic redirect isn't itself blocked.
 *
 * Requires a data router (createBrowserRouter) — see main.tsx.
 */
export function useUnsavedGuard(dirty: boolean) {
  const bypassRef = useRef(false)
  const blocker = useBlocker(() => dirty && !bypassRef.current)

  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty])

  const bypass = () => {
    bypassRef.current = true
  }

  return { blocker, bypass }
}
