import { useMutation, useQuery } from "@tanstack/react-query"
import { Archive, ArchiveRestore, Plus, Rocket, Trash2 } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { api } from "../../lib/api"
import { recordHref } from "../../lib/recordHref"
import { Badge, IconButton } from "../ui"
import type { InstanceCtx } from "./types"

/**
 * Version history + lifecycle for a versioned item. Lists every version (draft +
 * published), lets you switch between them, open a new draft, and publish/discard
 * the open draft. Every action is an icon button on its own row (publish/discard
 * on the draft, archive/restore on published versions) plus a "New version" row
 * styled like the version rows, so the whole content is one list and works the
 * same as a tile or a tab. Row actions target that row's version, not whichever
 * version you happen to be viewing. Per-version archive lives here; whole-item
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
      navigate(recordHref(d.id))
    },
  })
  const publish = useMutation({
    mutationFn: (v: { id: string; version: number }) => api.publishVersion(v.id, v.version),
    onSuccess: refetch,
  })
  const discard = useMutation({
    mutationFn: (v: { id: string }) => api.discardDraft(v.id),
    onSuccess: (_d, v) => {
      refetch()
      // Discarding the version you're viewing leaves you nowhere — fall back to head.
      if (v.id === current.id && headSeq != null) {
        const head = published.find((x) => x.versionSeq === headSeq)
        if (head) navigate(recordHref(head.id))
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

  const err =
    newVersion.error ||
    publish.error ||
    discard.error ||
    archiveVersion.error ||
    restoreVersion.error

  return (
    <>
      <div className="divide-y divide-border">
        {versions.length === 0 && (
          <div className="px-6 py-2 text-sm text-muted-foreground">No versions yet.</div>
        )}
        {[...versions].reverse().map((v) => {
          const isHead = v.versionStatus === "published" && v.versionSeq === headSeq
          const isCurrent = v.id === current.id
          return (
            <div
              key={v.id}
              // The row you're viewing reads as active from its fill + bolder
              // label alone. pr-3, not px-6: the icon buttons carry ~9px of their
              // own padding, so a full 24px right inset reads as lopsided.
              className={`flex min-h-10 items-center justify-between gap-2 py-1 pr-3 pl-6 ${
                isCurrent ? "bg-accent" : "hover:bg-accent/40"
              }`}
            >
              <button
                type="button"
                onClick={() => navigate(recordHref(v.id))}
                disabled={isCurrent}
                className="flex items-center gap-2 text-left text-sm disabled:cursor-default hover:underline disabled:hover:no-underline"
              >
                <span
                  className={
                    isCurrent
                      ? "font-semibold text-foreground"
                      : "font-medium text-muted-foreground"
                  }
                >
                  v{v.versionSeq}
                </span>
                {v.versionStatus === "draft" ? (
                  <Badge tone="amber">Draft</Badge>
                ) : isHead ? (
                  <Badge tone="green">Latest</Badge>
                ) : (
                  <Badge tone="gray">Published</Badge>
                )}
                {v.archivedAt && <Badge tone="gray">Archived</Badge>}
                {isCurrent && (
                  <span className="text-xs font-medium text-muted-foreground">Viewing</span>
                )}
              </button>
              <div className="flex shrink-0 items-center gap-0.5">
                {v.versionStatus === "draft" ? (
                  <>
                    <IconButton
                      aria-label={`Publish v${v.versionSeq}`}
                      title="Publish this draft"
                      disabled={publish.isPending}
                      onClick={() => publish.mutate({ id: v.id, version: v.version })}
                    >
                      <Rocket size={14} />
                    </IconButton>
                    <IconButton
                      aria-label={`Discard v${v.versionSeq}`}
                      title="Discard this draft"
                      variant="danger"
                      disabled={discard.isPending}
                      onClick={() => discard.mutate({ id: v.id })}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </>
                ) : v.archivedAt ? (
                  <IconButton
                    aria-label={`Restore v${v.versionSeq}`}
                    title="Restore this version"
                    disabled={restoreVersion.isPending}
                    onClick={() => restoreVersion.mutate({ id: v.id, version: v.version })}
                  >
                    <ArchiveRestore size={14} />
                  </IconButton>
                ) : (
                  <IconButton
                    aria-label={`Archive v${v.versionSeq}`}
                    title="Archive this version"
                    disabled={archiveVersion.isPending}
                    onClick={() => archiveVersion.mutate({ id: v.id, version: v.version })}
                  >
                    <Archive size={14} />
                  </IconButton>
                )}
              </div>
            </div>
          )
        })}
        {/* Create sits in the list, shaped like a version row. One draft at a
            time, so it's disabled while a draft is open. */}
        <button
          type="button"
          onClick={() => newVersion.mutate()}
          disabled={newVersion.isPending || !!draft}
          title={draft ? "Publish or discard the open draft first" : undefined}
          className="flex min-h-10 w-full items-center gap-2 px-6 py-1 text-left text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus size={14} />
          {newVersion.isPending ? "Creating…" : "New version"}
        </button>
      </div>
      {err && <p className="px-6 py-2 text-sm text-destructive">{(err as Error).message}</p>}
    </>
  )
}
