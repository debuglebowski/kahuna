import { useMutation, useQuery } from "@tanstack/react-query"
import { Archive, ArchiveRestore, Check, GitBranch } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { api } from "../../lib/api"
import { Badge, Button } from "../ui"
import type { InstanceCtx } from "./types"

/**
 * Version history + lifecycle for a versioned item. Lists every version (draft +
 * published), lets you switch between them, open a new draft, and publish/discard
 * the open draft. Lifecycle buttons render as a toolbar row inside the body (not
 * tile-header actions) so their errors have somewhere to show, and the content
 * works the same as a tile or a tab. Per-version archive lives here; whole-item
 * archive is on the page header.
 */
export function VersionsBody({ ctx }: { ctx: InstanceCtx }) {
  const { instance: current, refetch: onChanged } = ctx
  const itemId = current.itemId
  const navigate = useNavigate()
  const versionsQ = useQuery({
    queryKey: ["versions", itemId],
    queryFn: () => api.listVersions(itemId),
  })
  const versions = versionsQ.data ?? []
  const published = versions.filter((v) => v.versionStatus === "published" && !v.archivedAt)
  const headSeq = published.length ? Math.max(...published.map((v) => v.versionSeq)) : null
  const draft = versions.find((v) => v.versionStatus === "draft" && !v.archivedAt)

  const refetch = () => {
    versionsQ.refetch()
    onChanged()
  }
  const newVersion = useMutation({
    mutationFn: () => api.newVersion(itemId),
    onSuccess: (d) => {
      refetch()
      navigate(`/instances/${d.id}`)
    },
  })
  const publish = useMutation({
    mutationFn: () => api.publishVersion(current.id, current.version),
    onSuccess: refetch,
  })
  const discard = useMutation({
    mutationFn: () => api.discardDraft(current.id),
    onSuccess: () => {
      refetch()
      if (headSeq != null) {
        const head = published.find((v) => v.versionSeq === headSeq)
        if (head) navigate(`/instances/${head.id}`)
      }
    },
  })
  const archiveVersion = useMutation({
    mutationFn: (v: { id: string; version: number }) => api.archiveInstance(v.id, v.version),
    onSuccess: refetch,
  })
  const restoreVersion = useMutation({
    mutationFn: (v: { id: string; version: number }) => api.restoreInstance(v.id, v.version),
    onSuccess: refetch,
  })

  const onDraft = current.versionStatus === "draft"
  const err =
    newVersion.error ||
    publish.error ||
    discard.error ||
    archiveVersion.error ||
    restoreVersion.error

  return (
    <>
      <div className="flex items-center justify-end gap-2 border-b border-border px-6 py-2">
        {onDraft ? (
          <>
            <Button onClick={() => publish.mutate()} disabled={publish.isPending}>
              <Check size={15} />
              {publish.isPending ? "Publishing…" : "Publish"}
            </Button>
            <Button variant="outline" onClick={() => discard.mutate()} disabled={discard.isPending}>
              Discard
            </Button>
          </>
        ) : (
          // One draft at a time: "New version" is disabled while a draft is open.
          <Button
            onClick={() => newVersion.mutate()}
            disabled={newVersion.isPending || !!draft}
            title={draft ? "Publish or discard the open draft first" : undefined}
          >
            <GitBranch size={15} />
            New version
          </Button>
        )}
      </div>
      <div className="divide-y divide-border">
        {versions.length === 0 && (
          <div className="p-6 text-sm text-muted-foreground">No versions yet.</div>
        )}
        {[...versions].reverse().map((v) => {
          const isHead = v.versionStatus === "published" && v.versionSeq === headSeq
          const isCurrent = v.id === current.id
          return (
            <div
              key={v.id}
              className={`flex items-center justify-between px-6 py-2 ${isCurrent ? "bg-accent/40" : ""}`}
            >
              <button
                type="button"
                onClick={() => navigate(`/instances/${v.id}`)}
                className="flex items-center gap-2 text-left text-sm hover:underline"
              >
                <span className="font-medium text-foreground">v{v.versionSeq}</span>
                {v.versionStatus === "draft" ? (
                  <Badge tone="amber">Draft</Badge>
                ) : isHead ? (
                  <Badge tone="green">Latest</Badge>
                ) : (
                  <Badge tone="gray">Published</Badge>
                )}
                {v.archivedAt && <Badge tone="gray">Archived</Badge>}
              </button>
              {v.versionStatus === "published" &&
                (v.archivedAt ? (
                  <Button
                    variant="ghost"
                    onClick={() => restoreVersion.mutate({ id: v.id, version: v.version })}
                  >
                    <ArchiveRestore size={14} />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => archiveVersion.mutate({ id: v.id, version: v.version })}
                    title="Archive this version"
                  >
                    <Archive size={14} />
                  </Button>
                ))}
            </div>
          )
        })}
      </div>
      {err && <p className="px-6 pb-4 text-sm text-destructive">{(err as Error).message}</p>}
    </>
  )
}
