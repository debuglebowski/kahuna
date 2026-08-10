import { useEffect, useState } from "react"

/**
 * Quick-edit is a sticky per-concept mode (localStorage), shared by every
 * surface that shows the concept's table — the concept page and dashboard list
 * widgets. A custom event keeps simultaneous consumers in sync (the Display
 * toggle on a dashboard-ized concept page must flip its list widgets live).
 */

const storageKey = (conceptId: string) => `kqe:${conceptId}`
const EVENT = "allting:quick-edit"

export function useQuickEdit(conceptId: string): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(false)
  useEffect(() => {
    setOn(localStorage.getItem(storageKey(conceptId)) === "1")
    const handle = (e: Event) => {
      const d = (e as CustomEvent<{ conceptId: string; on: boolean }>).detail
      if (d?.conceptId === conceptId) setOn(d.on)
    }
    window.addEventListener(EVENT, handle)
    return () => window.removeEventListener(EVENT, handle)
  }, [conceptId])
  const set = (v: boolean) => {
    try {
      localStorage.setItem(storageKey(conceptId), v ? "1" : "0")
    } catch {
      // ignore (private mode / storage disabled)
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { conceptId, on: v } }))
  }
  return [on, set]
}
