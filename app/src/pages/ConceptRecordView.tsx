import { useQuery } from "@tanstack/react-query"
import { CircleAlert } from "lucide-react"
import { useNavigate, useParams } from "react-router-dom"
import { Button, Spinner } from "../components/ui"
import { api } from "../lib/api"
import { conceptBySlug, useSingleRecord } from "../lib/singleRecord"
import { InstanceViewBody } from "./InstanceView"

/**
 * A single-record concept's record at `/c/<slug>` — the whole point of the mode:
 * one URL, no instance id, so the concept behaves like a page rather than a list.
 *
 * Renders through {@link InstanceViewBody}, the SAME component `/instances/:id`
 * uses, so the record view, its widgets, and the amendment banner all behave
 * identically. Only the resolution differs (slug → concept → its one record).
 */
export function ConceptRecordView() {
  const { slug = "" } = useParams()
  const navigate = useNavigate()
  // Cached on every page already — resolving the slug here costs no round trip.
  const concepts = useQuery({ queryKey: ["concepts"], queryFn: () => api.listConcepts() })
  const concept = conceptBySlug(concepts.data, slug)
  const { detail, loading, refetch } = useSingleRecord(concept?.id ?? "")

  if (concepts.isLoading) return <Spinner />
  // No such slug, or it names a concept with no `/c/` address (archived, single
  // record switched off, or restricted to admins). All dead links, not errors —
  // and deliberately NOT enumerated below: listing the reasons would tell a member
  // that "restricted" is the one that applies.
  if (!concept) {
    return (
      <Fault
        title="Page not found"
        message={`Nothing is published at /c/${slug}.`}
        onHome={() => navigate("/")}
      />
    )
  }
  // The flag is on but nothing came back — the invariant leaked (the record was
  // removed out from under the flag). Say so plainly; a spinner would hang here.
  if (!loading && !detail) {
    return (
      <Fault
        title={`${concept.name} has no record`}
        message="Single record mode is on, but this concept has no record — that shouldn't be possible. Switching the mode off and on again in concept settings will recreate it."
        onHome={() => navigate(`/settings/concepts/${concept.id}`)}
        homeLabel="Open concept settings"
      />
    )
  }
  return <InstanceViewBody detail={detail} loading={loading} refetch={refetch} />
}

/** A dead-end state with one way out — used for both a bad slug and a missing record. */
function Fault({
  title,
  message,
  onHome,
  homeLabel = "Go home",
}: {
  title: string
  message: string
  onHome: () => void
  homeLabel?: string
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="rounded-full bg-muted p-3 text-muted-foreground">
        <CircleAlert size={22} />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" onClick={onHome}>
        {homeLabel}
      </Button>
    </div>
  )
}
