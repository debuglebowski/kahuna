import { useEffect, useState } from "react"

/**
 * A `now` timestamp that ticks on an interval — drives client-side decay/
 * momentum drift so bands advance with wall-clock time, no refetch.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
