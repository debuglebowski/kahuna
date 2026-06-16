import { createContext, useContext, useLayoutEffect, useRef, useState } from "react"

/** The rendered pixel box of a widget tile. Widgets read this (not any stored
 *  dimension) to pick size-adaptive variants, since the auto-layout makes their
 *  on-screen size emergent. */
export interface Box {
  width: number
  height: number
}

const BoxContext = createContext<Box>({ width: 0, height: 0 })
export const WidgetBoxProvider = BoxContext.Provider
export const useWidgetBox = (): Box => useContext(BoxContext)

/** Track an element's content-box size, live. */
export function useElementSize<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<Box>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}
