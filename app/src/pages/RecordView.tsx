import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  Archive,
  EllipsisVertical,
  LayoutDashboard,
  Pencil,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { RecordDetail } from "../../rpc/contract"
import { WidgetCanvas } from "../components/dashboard/WidgetCanvas"
import { usePageChrome } from "../components/Layout"
import { ManagedRecordVersionView } from "../components/recordVersion/ManagedRecordVersionView"
import type { RecordVersionCtx } from "../components/recordVersion/types"
import { Badge, Button, ConfirmDialog, Spinner } from "../components/ui"
import { api } from "../lib/api"
import { useSession } from "../lib/auth-client"
import { KEY, recordDetail, useRegisterCollection } from "../lib/collections"
import { conceptIndex, useConceptData } from "../lib/conceptData"
import { migrate, referencedConceptIds } from "../lib/dashboards"
import { canEditVersion, isAmending } from "../lib/editability"
import { resolveRecordDashboard } from "../lib/recordDashboards"
import { recordLabel } from "../lib/recordLabel"
import { useFullOrg, useIsAdmin } from "./settings/SettingsLayout"

/** Single-record version detail at `/records/:id` — reads the id from the route and
 *  renders {@link RecordVersionViewBody}. */
export function RecordView() {
  const { id = "" } = useParams()
  const collection = recordDetail(id)
  useRegisterCollection(KEY.detail(id), collection)
  const detailQ = useLiveQuery(
    (q) => (id ? q.from({ d: collection }) : undefined),
    [id, collection],
  )
  return (
    <RecordVersionViewBody
      detail={detailQ.data?.[0]}
      loading={detailQ.isLoading}
      refetch={() => collection.utils.refetch()}
    />
  )
}

/**
 * The record page proper: all of a record version's own data plus everything connected
 * to it, rendered through the concept's record view (a per-concept dashboard set
 * in concept settings).
 *
 * Takes the resolved detail rather than an id so the two routes that reach a
 * record can share it: `/records/:id` looks the record version up directly, while
 * `/c/<slug>` resolves a single-record concept to its one record first (a
 * different collection, keyed by concept id — see `singleRecordOfConcept`).
 * `refetch` is the caller's collection refetch, threaded into `RecordVersionCtx` so
 * widget writes still refresh through whichever collection owns the data.
 */
export function RecordVersionViewBody({
  detail,
  loading,
  refetch,
}: {
  detail: RecordDetail | undefined
  loading: boolean
  /** Defaults to a no-op only if the caller has nothing to refetch. */
  refetch?: () => void
}) {
  usePageChrome({ fullWidth: true, fillHeight: true }) // tile grid fills the viewport

  // A hard delete is admin-only; archive is an ordinary record write.
  const navigate = useNavigate()
  const { data: session } = useSession()
  const org = useFullOrg()
  const { admin } = useIsAdmin()
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null)

  // All concepts — to resolve relation targets' versioningEnabled in the picker.
  const allConcepts = useQuery({ queryKey: ["concepts"], queryFn: () => api.listConcepts() })

  // Resolve which record dashboard renders this record: an explicit `?view=`, else
  // the concept's default. There is NO built-in fallback — a concept with no record
  // view renders the empty state below. Record dashboards are per-concept templates;
  // the current record is supplied to the widgets as context.
  const [searchParams] = useSearchParams()
  const viewRef = searchParams.get("view")
  const conceptId = detail?.concept.id
  const recordDashQ = useQuery({
    queryKey: ["recordDashboards", conceptId],
    queryFn: () => api.listRecordDashboards(conceptId as string),
    enabled: !!conceptId,
  })
  const chosen = useMemo(
    () => resolveRecordDashboard(recordDashQ.data ?? [], viewRef),
    [recordDashQ.data, viewRef],
  )
  const body = useMemo(() => migrate(chosen ? chosen.body : { widgets: [] }), [chosen])
  const referencedIds = useMemo(() => referencedConceptIds(body), [body])
  const { instData, loaders } = useConceptData(referencedIds)
  const cIndex = useMemo(() => conceptIndex(allConcepts.data ?? []), [allConcepts.data])

  // The record leaves the live view on success — land on the dashboards home
  // (concepts have no page of their own).
  const backToConcept = () => {
    navigate("/dashboards")
  }
  const archive = useMutation({
    mutationFn: (target: { id: string; version: number }) =>
      api.archiveRecordVersion(target.id, target.version),
    onSuccess: () => {
      setDialog(null)
      backToConcept()
    },
  })
  // For a versioned concept the header "Archive" hides the whole record;
  // per-version archive lives in the Versions panel.
  const archiveRecord = useMutation({
    mutationFn: (recordId: string) => api.archiveRecord(recordId),
    onSuccess: () => {
      setDialog(null)
      backToConcept()
    },
  })
  const del = useMutation({
    mutationFn: (recordVersionId: string) => api.deleteRecordVersion(recordVersionId),
    onSuccess: () => {
      setDialog(null)
      backToConcept()
    },
  })
  if (loading || !detail) return <Spinner />

  const { recordVersion, concept, fields, inboundRelationFields, related, staticLabels, labels } =
    detail
  const relationFields = fields.filter((f) => f.kind === "relation")
  // A single-record concept's record has no name of its own to fall back on — it
  // IS the concept — so the concept's name stands in for "(untitled)" rather than
  // the header reading "Company / (untitled)" until someone fills a field in.
  const label = recordLabel(
    recordVersion,
    fields,
    concept.titleFieldId,
    concept.singleRecord ? concept.name : undefined,
  )
  const editable = canEditVersion(concept, recordVersion)
  // Editing a published version is an amendment: it reaches everyone referencing
  // that version, so say so rather than letting it look like an ordinary edit.
  const amending = isAmending(concept, recordVersion)

  const ctx: RecordVersionCtx = {
    recordVersion,
    concept,
    fields,
    related,
    staticLabels,
    ownLabels: labels,
    relationFields,
    inboundRelationFields,
    editable,
    admin,
    myUserId: session?.user.id,
    members: org.data?.members ?? [],
    concepts: allConcepts.data ?? [],
    refetch: () => refetch?.(),
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-1.5 text-base font-medium text-foreground">
          {/* Concepts have no page of their own (dashboards are the only view
              surface), so the breadcrumb root is informational. A single-record
              concept has no collection to root into — and its label already IS the
              concept — so the crumb is dropped rather than reading "Company /
              Company". */}
          {!concept.singleRecord && (
            <>
              <span className="truncate text-muted-foreground">
                {concept.pluralName || concept.name}
              </span>
              <span className="text-muted-foreground/50">/</span>
            </>
          )}
          <span className="truncate">{label}</span>
          {concept.versioningEnabled &&
            (recordVersion.versionStatus === "draft" ? (
              <Badge tone="amber">Draft v{recordVersion.versionSeq}</Badge>
            ) : (
              <Badge tone="gray">v{recordVersion.versionSeq}</Badge>
            ))}
        </h2>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                aria-label="Record actions"
              >
                <EllipsisVertical size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => navigate(`/settings/concepts/${concept.id}`)}>
                <Pencil size={15} />
                Edit concept
              </DropdownMenuItem>
              {chosen && (
                <DropdownMenuItem
                  onSelect={() =>
                    navigate(`/settings/dashboards/${chosen.id}?concept=${concept.id}&tab=layout`)
                  }
                >
                  <LayoutDashboard size={15} />
                  Edit layout
                </DropdownMenuItem>
              )}
              {/* Neither action exists for a single-record concept's record: the
                  engine refuses both with `SingleRecordProtected` (the flag promises
                  the record exists), so offering them would only ever produce an
                  error. Removing the mode, or deleting the concept, is the way out —
                  both live in concept settings, one menu item up. */}
              {!concept.singleRecord && (
                <>
                  <DropdownMenuItem onSelect={() => setDialog("archive")}>
                    <Archive size={15} />
                    Archive
                  </DropdownMenuItem>
                  {admin && (
                    <DropdownMenuItem variant="destructive" onSelect={() => setDialog("delete")}>
                      <Trash2 size={15} />
                      Delete
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Amending is the one edit whose blast radius isn't obvious from the page:
          a pinned reference points at THIS version row, so the change reaches
          everyone referencing it rather than landing on a fresh version. */}
      {amending && (
        <div className="flex shrink-0 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-muted-foreground">
          <TriangleAlert size={13} className="shrink-0 text-amber-600 dark:text-amber-500" />
          <span className="min-w-0 flex-1">
            Editing published v{recordVersion.versionSeq} — changes are live to everyone referencing
            this version.
          </span>
        </div>
      )}

      {loaders}
      {concept.managedBy ? (
        <ManagedRecordVersionView ctx={ctx} />
      ) : !recordDashQ.data ? (
        <Spinner />
      ) : chosen ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <WidgetCanvas
            body={body}
            instData={instData}
            cIndex={cIndex}
            conceptsLoaded={!!allConcepts.data}
            record={ctx}
            readOnly
          />
        </div>
      ) : (
        <NoRecordView concept={concept} />
      )}

      {dialog === "archive" && (
        <ConfirmDialog
          title="Archive record"
          message={
            concept.versioningEnabled ? (
              <>
                Archive <strong>{label}</strong> and all its versions? It's hidden from lists but
                kept — restore it from "Show archived".
              </>
            ) : (
              <>
                Archive <strong>{label}</strong>? It's hidden from lists but kept — you can restore
                it from the {concept.name} view's "Show archived".
              </>
            )
          }
          confirmLabel="Archive"
          pending={archive.isPending || archiveRecord.isPending}
          error={
            (archive.error || archiveRecord.error
              ? ((archive.error || archiveRecord.error) as { message?: string }).message
              : undefined) ?? undefined
          }
          onConfirm={() =>
            concept.versioningEnabled
              ? archiveRecord.mutate(recordVersion.recordId)
              : archive.mutate(recordVersion)
          }
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title="Delete record"
          message={
            <>
              Permanently delete <strong>{label}</strong>? This can't be undone, and is refused
              while other records still link to it.
            </>
          }
          confirmLabel="Delete"
          confirmVariant="danger"
          secondaryLabel="Archive instead"
          onSecondary={() => archive.mutate(recordVersion)}
          pending={del.isPending || archive.isPending}
          error={
            del.error
              ? ((del.error as { message?: string }).message ?? "Could not delete.")
              : undefined
          }
          onConfirm={() => del.mutate(recordVersion.id)}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  )
}

/** Shown when a concept has no record view configured — there is no built-in
 *  fallback layout, so the record can't render until someone sets one up on the
 *  concept's Layout tab. */
function NoRecordView({ concept }: { concept: { id: string; name: string } }) {
  const navigate = useNavigate()
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="rounded-full bg-muted p-3 text-muted-foreground">
        <LayoutDashboard size={22} />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">No record view configured</h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          {concept.name} has no record view yet, so there's nothing to display this record with.
          Configure one to choose which widgets appear.
        </p>
      </div>
      <Button onClick={() => navigate(`/settings/concepts/${concept.id}?tab=layout`)}>
        Configure record view
      </Button>
    </div>
  )
}
