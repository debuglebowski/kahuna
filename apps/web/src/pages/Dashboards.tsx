import { useLiveQuery } from "@tanstack/react-db"
import { useQuery } from "@tanstack/react-query"
import { LayoutDashboard, Settings } from "lucide-react"
import { useMemo } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { WidgetCanvas } from "@/components/dashboard/WidgetCanvas"
import { usePageChrome } from "@/components/Layout"
import { Button, IconButton, Spinner } from "@/components/ui"
import { api, type Concept } from "@/lib/api"
import { conceptsCollection, KEY, useRegisterCollection } from "@/lib/collections"
import { conceptIndex, useConceptData } from "@/lib/conceptData"
import { referencedConceptIds } from "@/lib/dashboards"

/**
 * The dashboard canvas (`/dashboards`) — a READ-ONLY render of the selected
 * dashboard (chosen via the URL `:id`). ALL management (create, reorder, and
 * the edit modal — meta and layout alike) lives in Settings → Dashboards; this
 * page just re-reads the `dashboards` query.
 */
export function Dashboards() {
  usePageChrome({ fullWidth: true }) // widget canvas uses the whole viewport width
  const navigate = useNavigate()
  const conceptsLive = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  useRegisterCollection(KEY.concepts, conceptsCollection)
  const concepts = (conceptsLive.data ?? []) as Concept[]
  const conceptsLoaded = !!conceptsLive.data
  const cIndex = useMemo(() => conceptIndex(concepts), [concepts])

  // Loading the list seeds the org's Home dashboard server-side (ensureDefault).
  const { data: dashboards } = useQuery({
    queryKey: ["dashboards"],
    queryFn: () => api.listDashboards(),
  })
  // The selected dashboard lives in the URL (`/dashboards/:id`) so every
  // dashboard is addressable — sidebar entries, links, reloads all land right.
  const { id: routeId } = useParams()
  const selected = useMemo(() => {
    const all = dashboards ?? []
    if (routeId) return all.find((d) => d.id === routeId) ?? null
    // Default landing: the lowest-position org-shared dashboard, else the first.
    return (
      all.filter((d) => d.ownerId === null).sort((a, b) => a.position - b.position)[0] ??
      all[0] ??
      null
    )
  }, [dashboards, routeId])

  const body = selected?.body ?? null
  const ids = useMemo(() => (body ? referencedConceptIds(body) : []), [body])
  const { instData, loaders } = useConceptData(ids)

  if (!dashboards) return <Spinner />
  if (!selected || !body)
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Dashboard not found — it may have been deleted.
      </p>
    )

  return (
    <div className="flex flex-col gap-4">
      {loaders}
      <header className="flex items-center justify-between gap-2">
        <h1 className="cancel-drag text-xl font-semibold">
          {selected.name}
          {selected.ownerId ? " · personal" : ""}
        </h1>

        <IconButton
          aria-label="Dashboard settings"
          onClick={() => navigate(`/settings/dashboards/${selected.id}?tab=layout`)}
        >
          <Settings size={15} />
        </IconButton>
      </header>

      {body.widgets.length === 0 ? (
        <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed p-12 text-center">
          <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <LayoutDashboard size={20} />
          </div>
          <h2 className="mb-1 text-lg font-medium text-foreground">An empty canvas</h2>
          <p className="mb-4 max-w-sm text-sm text-balance text-muted-foreground">
            This dashboard has no widgets yet — add some from its settings.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(`/settings/dashboards/${selected.id}?tab=layout`)}
          >
            <Settings size={14} /> Dashboard settings
          </Button>
        </div>
      ) : (
        <WidgetCanvas
          body={body}
          instData={instData}
          cIndex={cIndex}
          conceptsLoaded={conceptsLoaded}
          readOnly
        />
      )}
    </div>
  )
}
