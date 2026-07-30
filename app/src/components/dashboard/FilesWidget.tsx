import { useQuery } from "@tanstack/react-query"
import { api, type DashboardWidget, type FileOwner } from "@/lib/api"
import { KEY, useRegisterCollection } from "@/lib/collections"
import { arrangeFiles } from "@/lib/files"
import { queryClient } from "@/lib/queryClient"
import { useSingleRecord } from "@/lib/singleRecord"
import { FileDropZone, FileList } from "../files/FileList"
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
 * Files — uploads browsed at a scope: one record (`instanceId`, resolved to its
 * item lineage), a concept (recent across its records), the whole org, or this
 * widget's own `bucketId` (files owned by no record). A consumer of the same RPCs
 * as the instance tile's Files panel. Uploads land on the record or the bucket;
 * concept/org scope have no single target, so they browse only.
 */
export function FilesWidget({ widget }: { widget: Files }) {
  const scope = widget.scope
  const configured =
    scope === "org" ||
    (scope === "concept"
      ? !!widget.conceptId
      : scope === "widget"
        ? !!widget.bucketId
        : !!widget.instanceId)

  useRegisterCollection(KEY.filesGlobal, filesRefetchShim)

  const filesQ = useQuery({
    queryKey: [
      "files",
      scope,
      widget.conceptId ?? null,
      widget.instanceId ?? null,
      widget.bucketId ?? null,
    ],
    queryFn: () =>
      api.listFiles(
        scope === "concept"
          ? { conceptId: widget.conceptId ?? undefined }
          : scope === "instance"
            ? { instanceId: widget.instanceId ?? undefined }
            : scope === "widget"
              ? { bucketId: widget.bucketId ?? undefined }
              : {},
      ),
    enabled: configured,
  })
  // Upload targets. A bucket IS the target, so it needs no resolution; a record
  // stores an instance ref while files hang off the item lineage — resolve that
  // one hop, and only when the drop-zone will actually render.
  const wantsUpload =
    !!widget.allowUpload &&
    ((scope === "instance" && !!widget.instanceId) || (scope === "widget" && !!widget.bucketId))
  const itemQ = useQuery({
    queryKey: ["instanceItem", widget.instanceId],
    queryFn: () => api.getInstance(widget.instanceId ?? ""),
    enabled: wantsUpload && scope === "instance",
  })
  const owner: FileOwner | null =
    scope === "widget"
      ? widget.bucketId
        ? { bucketId: widget.bucketId, shared: widget.bucketShared !== false }
        : null
      : itemQ.data
        ? { itemId: itemQ.data.instance.itemId }
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

  const files = arrangeFiles(filesQ.data ?? [], {
    sort: widget.sort,
    fileType: widget.fileType,
    limit: widget.limit,
  })

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {wantsUpload && owner && (
        <div className="pb-2">
          <FileDropZone owner={owner} onUploaded={() => filesQ.refetch()} />
        </div>
      )}
      <FileList
        files={files}
        variant={widget.variant === "gallery" ? "gallery" : "list"}
        onChanged={() => filesQ.refetch()}
        emptyText={scope === "widget" ? "No files here yet." : "No files at this scope yet."}
      />
    </div>
  )
}

/**
 * `bindToConceptRecord` Files: resolves the single-record concept's record, then
 * renders the ordinary widget with that `instanceId`. A wrapper rather than a
 * branch inside `FilesWidget` because the resolution is a hook — `WidgetCanvas`'s
 * arm is a plain switch, and hooking there would make the hook count vary per
 * widget config.
 */
export function ConceptRecordFilesWidget({ widget }: { widget: Files }) {
  const { instanceId, loading } = useSingleRecord(widget.conceptId ?? "")
  if (loading) return <Spinner />
  // No record (flag switched off, or the concept is gone) falls through to the
  // widget's own "pick a record" empty state.
  return <FilesWidget widget={{ ...widget, instanceId }} />
}
