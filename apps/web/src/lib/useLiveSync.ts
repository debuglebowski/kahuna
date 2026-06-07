import { useEffect } from "react"
import { mountedKeys, refetchKeys } from "./collections"
import { type LiveEnvelope, routeEnvelope } from "./routeEnvelope"

/**
 * Opens the single SSE connection and turns each event envelope into a
 * targeted, debounced refetch of the affected (mounted) collections. Mount
 * once, high in the tree (Layout). EventSource handles reconnection and resends
 * `Last-Event-ID` automatically, so the server replays missed events.
 */
export function useLiveSync(): void {
  useEffect(() => {
    const es = new EventSource("/api/stream")
    const dirty = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let opened = false

    const flush = () => {
      timer = undefined
      const keys = [...dirty]
      dirty.clear()
      void refetchKeys(keys)
    }

    es.addEventListener("km", (e) => {
      let envelope: LiveEnvelope
      try {
        envelope = JSON.parse((e as MessageEvent).data)
      } catch {
        return
      }
      for (const k of routeEnvelope(envelope, mountedKeys())) dirty.add(k)
      if (!timer) timer = setTimeout(flush, 120)
    })

    es.onopen = () => {
      // On RE-open (not the first), catch up everything mounted — belt-and-
      // suspenders on top of the server's Last-Event-ID replay.
      if (opened) void refetchKeys(mountedKeys())
      opened = true
    }

    return () => {
      es.close()
      if (timer) clearTimeout(timer)
    }
  }, [])
}
