import { useSyncExternalStore } from "react"

/**
 * App color theme. "system" follows the OS preference live; the choice is
 * persisted per browser. The pre-paint script in index.html reads the same
 * key so the first frame already has the right `.dark` class — this module
 * keeps it in sync from then on.
 */
export type Theme = "light" | "dark" | "system"

const THEME_KEY = "km.theme"
const media = window.matchMedia("(prefers-color-scheme: dark)")

const readStored = (): Theme => {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch {
    return "system"
  }
}

let theme: Theme = readStored()
const listeners = new Set<() => void>()

const apply = () => {
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" || (theme === "system" && media.matches),
  )
}

export function setTheme(next: Theme) {
  theme = next
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {}
  apply()
  for (const l of listeners) l()
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => theme,
  )
}

// Module side effects: re-apply on OS preference changes (matters in "system"
// mode) and once on load, in case the pre-paint script was edited out of date.
media.addEventListener("change", apply)
apply()
