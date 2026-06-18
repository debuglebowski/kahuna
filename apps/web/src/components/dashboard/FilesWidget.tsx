import { useQuery } from "@tanstack/react-query"
import { api, type DashboardWidget } from "@/lib/api"
import { KEY, useRegisterCollection } from "@/lib/collections"
import { arrangeFiles } from "@/lib/files"
import { queryClient } from "@/lib/queryClient"
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
 * item lineage), a concept (recent across its records), or the whole org. A
 * consumer of the same RPCs as the instance tile's Files panel; the drop-zone
 * only renders on instance scope (the other scopes have no upload target).
 */
export function FilesWidget({ widget }: { widget: Files }) {
  const scope = widget.scope
  const configured =
    scope === "org" || (scope === "concept" ? !!widget.conceptId : !!widget.instanceId)

  useRegisterCollection(KEY.filesGlobal, filesRefetchShim)

  const filesQ = useQuery({
    queryKey: ["files", scope, widget.conceptId ?? null, widget.instanceId ?? null],
    queryFn: () =>
      api.listFiles(
        scope === "concept"
          ? { conceptId: widget.conceptId ?? undefined }
          : scope === "instance"
            ? { instanceId: widget.instanceId ?? undefined }
            : {},
      ),
    enabled: configured,
  })
  // The upload target: files hang off the item lineage, the widget stores an
  // instance ref — resolve once (only when the drop-zone will render).
  const wantsUpload = scope === "instance" && !!widget.allowUpload && !!widget.instanceId
  const itemQ = useQuery({
    queryKey: ["instanceItem", widget.instanceId],
    queryFn: () => api.getInstance(widget.instanceId ?? ""),
    enabled: wantsUpload,
  })
  const itemId = itemQ.data?.instance.itemId

  if (!configured)
    return (
      <p className="text-sm text-muted-foreground">
        Pick a {scope === "concept" ? "concept" : "record"} in the widget settings.
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
      {wantsUpload && itemId && (
        <div className="pb-2">
          <FileDropZone itemId={itemId} onUploaded={() => filesQ.refetch()} />
        </div>
      )}
      <FileList
        files={files}
        variant={widget.variant === "gallery" ? "gallery" : "list"}
        onChanged={() => filesQ.refetch()}
        emptyText="No files at this scope yet."
      />
    </div>
  )
}
