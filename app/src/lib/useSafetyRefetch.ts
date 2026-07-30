import { useEffect } from "react"
import { mountedKeys, refetchKeys } from "./collections"

/**
 * Low-frequency full refetch of all mounted collections. The backstop for the
 * two cases Last-Event-ID replay can't cover: an in-session frame the hub drops
 * while the socket stays up, and a silently-dead LISTEN fiber (heartbeats keep
 * the socket looking healthy). Bounds worst-case staleness to one interval.
 */
export function useSafetyRefetch(intervalMs = 90_000): void {
  useEffect(() => {
    const t = setInterval(() => void refetchKeys(mountedKeys()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
}
