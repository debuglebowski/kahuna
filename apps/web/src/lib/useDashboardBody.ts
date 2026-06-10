import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Layout } from "react-grid-layout"
import { api, type Dashboard, type DashboardBody } from "./api"
import { applyLayouts } from "./dashboards"

/** True for the optimistic-concurrency RpcError (code DASHBOARD_CONFLICT). The
 *  client surfaces RPC failures as a wrapped error, so match code/message/text. */
const isConflictError = (e: unknown): boolean => {
  const o = e as { code?: unknown; message?: unknown } | null
  const s = `${o?.code ?? ""} ${o?.message ?? ""} ${String(e)}`
  return s.includes("DASHBOARD_CONFLICT") || s.includes("DashboardConflict")
}

/**
 * Owns a dashboard's body + serialized, conflict-aware persistence for the
 * dashboard canvas.
 * The local body is the source of truth while editing; saves run one-at-a-time
 * (latest wins) so rapid drags can't self-conflict; a genuine remote edit (the
 * `updatedAt` etag moved) reloads + flags a conflict instead of clobbering.
 */
export function useDashboardBody(dash: Dashboard | null) {
  const qc = useQueryClient()
  const [body, setBody] = useState<DashboardBody | null>(dash?.body ?? null)
  const [conflict, setConflict] = useState(false)
  const loadedId = useRef<string | null>(dash?.id ?? null)
  const etagRef = useRef<Date | null>(dash?.updatedAt ?? null)
  const savingRef = useRef(false)
  const pendingRef = useRef<{ id: string; body: DashboardBody } | null>(null)
  const idRef = useRef<string | null>(dash?.id ?? null)
  idRef.current = dash?.id ?? null

  // (Re)load the body only when the dashboard id changes, so live refetches never
  // clobber in-flight edits.
  useEffect(() => {
    if (dash && loadedId.current !== dash.id) {
      loadedId.current = dash.id
      setBody(dash.body)
      etagRef.current = dash.updatedAt ?? null
      setConflict(false)
    }
  }, [dash])

  const flush = useCallback(async () => {
    if (savingRef.current || pendingRef.current === null) return
    savingRef.current = true
    const job = pendingRef.current
    pendingRef.current = null
    try {
      const updated = await api.updateDashboard({
        id: job.id,
        body: job.body,
        expectedUpdatedAt: etagRef.current ?? undefined,
      })
      if (idRef.current === job.id) etagRef.current = updated.updatedAt ?? null
    } catch (e) {
      if (isConflictError(e) && idRef.current === job.id) {
        const fresh = await api.listDashboards().catch(() => null)
        const row = fresh?.find((d) => d.id === job.id)
        if (row && idRef.current === job.id) {
          setBody(row.body)
          etagRef.current = row.updatedAt ?? null
          if (fresh) qc.setQueryData(["dashboards"], fresh)
          setConflict(true)
        }
        pendingRef.current = null // drop the conflicting edit
      }
    } finally {
      savingRef.current = false
      if (pendingRef.current !== null) void flush()
    }
  }, [qc])

  const save = useCallback(
    (next: DashboardBody) => {
      const id = idRef.current
      if (!id) return
      pendingRef.current = { id, body: next }
      void flush()
    },
    [flush],
  )
  const mutate = useCallback(
    (next: DashboardBody) => {
      setBody(next)
      save(next)
    },
    [save],
  )
  const onStop = useCallback(
    (layout: Layout[]) => {
      setBody((cur) => {
        if (!cur) return cur
        const next = applyLayouts(cur, layout)
        save(next)
        return next
      })
    },
    [save],
  )

  return {
    body,
    mutate,
    onStop,
    conflict,
    dismissConflict: useCallback(() => setConflict(false), []),
  }
}
