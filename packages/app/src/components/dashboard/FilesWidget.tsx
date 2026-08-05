import { useQuery } from "@tanstack/react-query"
import { UploadCloud } from "lucide-react"
import { useState } from "react"
import { api, type DashboardWidget, type FileOwner } from "@/lib/api"
import { KEY, useRegisterCollection } from "@/lib/collections"
import { arrangeFiles, canMutateFile, uploadTarget } from "@/lib/files"
import { queryClient } from "@/lib/queryClient"
import { useSingleRecord } from "@/lib/singleRecord"
import { FileDropSurface, FileDropZone, FileList, useFileViewer } from "../files/FileList"
import { Spinner } from "../ui"

type Files = Extract<DashboardWidget, { type: "files" }>

// React-query keys aren't TanStack DB collections, so the SSE stream can't
// refetch them directly — register one shared shim under the files nudge key
// (any attachment event invalidates every files widget on screen).
const filesRefetchShim = {
  status: "ready",
  utils: { refetch: () => queryClient.invalidateQueries({ queryKey: ["files"] }) },
}

/**
 * Files — uploads browsed at a scope: one record (`recordVersionId`, resolved to its
 * record), a concept (recent across its records), the whole org, or this
 * widget's own `bucketId` (files owned by no record). A consumer of the same RPCs
 * as the record version tile's Files panel. Uploads land on the record or the bucket;
 * concept/org scope have no single target, so they browse only.
 *
 * `interactive` is the canvas's render-vs-arrange flag (see `document`). While
 * arranging, the canvas parks `pointer-events: none` over the whole widget body,
 * so a drop zone there can be neither dropped on nor clicked — it would silently
 * do nothing. The zone still renders, so the layout matches the live page, but it
 * says where uploads actually work instead of pretending to accept them.
 */
export function FilesWidget({
  widget,
  interactive = true,
  recordId,
}: {
  widget: Files
  interactive?: boolean
  /** The open record, on a record dashboard. Gives a wide-scope (org/concept)
   *  widget somewhere to put a dropped file — see `uploadTo`. */
  recordId?: string
}) {
  const scope = widget.scope
  const configured =
    scope === "org" ||
    (scope === "concept"
      ? !!widget.conceptId
      : scope === "widget"
        ? !!widget.bucketId
        : !!widget.recordVersionId)

  useRegisterCollection(KEY.filesGlobal, filesRefetchShim)
  // Who's looking — decides whether a row may be archived or deleted.
  const viewer = useFileViewer()

  // Archiving hides a file from the default list, so without a way back the archive
  // button is a trapdoor — restore would be unreachable from here.
  const [showArchived, setShowArchived] = useState(false)
  const filesQ = useQuery({
    queryKey: [
      "files",
      scope,
      widget.conceptId ?? null,
      widget.recordVersionId ?? null,
      widget.bucketId ?? null,
    ],
    // Always fetch archived rows and filter below, like the record tile does.
    // Fetching per toggle-state instead would report "0 archived" whenever they're
    // hidden — which is exactly when the count has to be right for the toggle to
    // appear at all.
    queryFn: () =>
      api.listFiles({
        ...(scope === "concept"
          ? { conceptId: widget.conceptId ?? undefined }
          : scope === "recordVersion"
            ? { recordVersionId: widget.recordVersionId ?? undefined }
            : scope === "widget"
              ? { bucketId: widget.bucketId ?? undefined }
              : {}),
        includeArchived: true,
      }),
    enabled: configured,
  })
  // Upload targets. A bucket IS the target, so it needs no resolution; a record
  // stores a record version ref while files hang off the record — resolve that
  // one hop, and only when the drop-zone will actually render.
  //
  // `allowUpload` defaults to ON wherever there IS a single owner to upload to.
  // It was opt-in, which meant a widget bound to one record or its own bucket
  // rendered no drop zone at all until someone found the toggle — an upload
  // surface that silently refuses uploads. Off is still honoured (explicit
  // `false` = read-only browse); absent now reads as "yes, this is uploadable",
  // which is what pointing a Files widget at one record already means.
  // Single rule for "is there anywhere to put a dropped file" — see `uploadTarget`.
  const target = uploadTarget(widget, recordId)
  const wantsUpload = target !== null
  // A wide scope borrowing the open record: the copy must name the destination.
  const widened = target?.kind === "record"
  const itemQ = useQuery({
    queryKey: ["instanceItem", widget.recordVersionId],
    queryFn: () => api.getRecord(widget.recordVersionId ?? ""),
    // Only a pinned record needs the id→lineage hop; a bucket and a borrowed record
    // are already usable as-is.
    enabled: target?.kind === "recordVersion",
  })
  const owner: FileOwner | null =
    target === null
      ? null
      : target.kind === "bucket"
        ? { bucketId: target.bucketId, shared: target.shared }
        : target.kind === "record"
          ? { recordId: target.recordId }
          : itemQ.data
            ? { recordId: itemQ.data.recordVersion.recordId }
            : null

  if (!configured)
    return (
      <p className="text-sm text-muted-foreground">
        {scope === "widget"
          ? "Re-pick the Widget scope in the widget settings to give this widget its own file store."
          : `Pick a ${scope === "concept" ? "concept" : "record"} in the widget settings.`}
      </p>
    )
  if (filesQ.isLoading) return <Spinner />
  if (filesQ.error)
    return <p className="text-sm text-destructive">{(filesQ.error as Error).message}</p>

  const all = filesQ.data ?? []
  const archivedCount = all.filter((f) => f.archivedAt).length
  // The widget's `limit` should count what's on screen, so filter archived out
  // BEFORE arranging — otherwise a limit of 5 could be spent on hidden rows.
  const files = arrangeFiles(showArchived ? all : all.filter((f) => !f.archivedAt), {
    sort: widget.sort,
    fileType: widget.fileType,
    limit: widget.limit,
  })

  // Files first, upload chrome last. The list is what you came to read; the drop
  // zone is an action, and actions belong under the content they add to.
  const body = (
    <>
      {/* Only the LIST scrolls. Were the whole body scrollable, a pinned-looking
          drop zone would drift off the bottom as soon as the list outgrew the tile
          — exactly the thing being fixed by moving it down here. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FileList
          files={files}
          variant={widget.variant === "gallery" ? "gallery" : "list"}
          onChanged={() => filesQ.refetch()}
          // Archive/delete were missing entirely: the widget passed no `canMutate`, so
          // it defaulted to false and every row offered only Download. Same
          // uploader-or-admin rule the server enforces, and the same one the record
          // tile already used.
          canMutate={(f) => canMutateFile(f, viewer)}
          emptyText={
            wantsUpload
              ? // There's a drop zone just below, so "no files" is the whole story.
                scope === "widget"
                ? "No files here yet."
                : "No files yet."
              : // No owner to upload to, so the emptiness is a dead end unless the copy
                // says why. Bare "no files" reads as "drag one in and it'll appear".
                widget.allowUpload === false
                ? "No files yet. Turn on “Allow upload” in the widget settings to drop files here."
                : scope === "org" || scope === "concept"
                  ? `No files at this scope yet. This widget browses ${scope === "org" ? "the whole org" : "a concept"} — put it on a record page, or set its Scope to a record or to this widget, to upload here.`
                  : "No files at this scope yet. Pick a record in the widget settings to upload here."
          }
        />
        {/* Inside the scroll area, under the rows it belongs to — it's a filter on
            the list, not a persistent control. Only worth a row when there's
            something archived to reveal or hide. */}
        {archivedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowArchived((s) => !s)}
            className="px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            {showArchived
              ? "Hide archived"
              : `Show ${archivedCount} archived ${archivedCount === 1 ? "file" : "files"}`}
          </button>
        )}
      </div>
      {wantsUpload &&
        owner &&
        (interactive ? (
          // `shrink-0`: stays put at the tile's foot however long the list gets. The
          // zone's own dashed outline already separates it — a rule above it just
          // adds a second line.
          <div className="shrink-0 pt-2">
            <FileDropZone owner={owner} onUploaded={() => filesQ.refetch()}>
              {/* At a wide scope the widget lists more than it owns, so name the
                  destination — otherwise dropping here looks like it uploads "to
                  the org", which isn't a thing a file can belong to. */}
              {widened ? "Drop files or click to upload — they attach to this record" : undefined}
            </FileDropZone>
          </div>
        ) : (
          // Arranging: the canvas has switched pointer events off over this
          // subtree, so keep the zone's footprint (the layout must match the live
          // page) but say plainly that uploads happen elsewhere.
          <div className="shrink-0 pt-2">
            <p className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-center text-sm text-muted-foreground">
              <UploadCloud size={16} aria-hidden />
              Uploads work on the dashboard itself — or hit Preview
            </p>
          </div>
        ))}
    </>
  )

  // The dashed strip is one band of a much larger tile, but "drag a file into the
  // Files widget" aims at the tile — so the whole widget takes the drop, with the
  // strip left in place as the visible affordance (and the click-to-browse).
  //
  // `overflow-hidden`, NOT `overflow-y-auto`: the scroll lives on the list inside,
  // so the drop zone stays pinned at the foot. Scrolling here too would nest two
  // scroll areas and let the zone slide away.
  return wantsUpload && owner && interactive ? (
    <FileDropSurface
      owner={owner}
      onUploaded={() => filesQ.refetch()}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      {body}
    </FileDropSurface>
  ) : (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">{body}</div>
  )
}

/**
 * `bindToConceptRecord` Files: resolves the single-record concept's record, then
 * renders the ordinary widget with that `recordVersionId`. A wrapper rather than a
 * branch inside `FilesWidget` because the resolution is a hook — `WidgetCanvas`'s
 * arm is a plain switch, and hooking there would make the hook count vary per
 * widget config.
 */
export function ConceptRecordFilesWidget({
  widget,
  interactive = true,
}: {
  widget: Files
  interactive?: boolean
}) {
  const { recordVersionId, loading } = useSingleRecord(widget.conceptId ?? "")
  if (loading) return <Spinner />
  // No record (flag switched off, or the concept is gone) falls through to the
  // widget's own "pick a record" empty state.
  return <FilesWidget widget={{ ...widget, recordVersionId }} interactive={interactive} />
}
