import { versionDate } from "@kahunalabs/contract"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  Archive,
  ArchiveRestore,
  Check,
  Pencil,
  Plus,
  Rocket,
  Trash2,
  Undo2,
  X,
} from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Textarea } from "@/components/ui/textarea"
import { api, type RecordVersion } from "../../lib/api"
import { useDeactivated } from "../../lib/members"
import { recordHref } from "../../lib/recordHref"
import { memberLabel } from "../record/AssigneePicker"
import { Badge, Button, IconButton, Modal } from "../ui"
import { ReleaseModal } from "./ReleaseModal"
import type { RecordVersionCtx } from "./types"

/**
 * Version history + lifecycle for a versioned item. Lists every version (draft +
 * published), lets you switch between them, open a new draft, and publish/discard
 * the open draft. Every action is an icon button on its own row (publish/discard
 * on the draft, archive/restore on published versions) plus a "New version" row
 * styled like the version rows, so the whole content is one list and works the
 * same as a tile or a tab. Row actions target that row's version, not whichever
 * version you happen to be viewing. Per-version archive lives here; whole-record
 * archive is on the page header.
 */
export function VersionsBody({ ctx }: { ctx: RecordVersionCtx }) {
  const { recordVersion: current, refetch: onChanged } = ctx
  const [modal, setModal] = useState<{ mode: "publish" | "info"; v: RecordVersion } | null>(null)
  const [rejecting, setRejecting] = useState<RecordVersion | null>(null)
  const deactivated = useDeactivated().set
  const pickable = ctx.members.filter((m) => !deactivated.has(m.userId))
  // A user id → display name; a former member shows as such rather than an id.
  const who = (userId: string | null) =>
    userId ? memberLabel(ctx.members.find((m) => m.userId === userId)) : null
  const recordId = current.recordId
  // Every way to destroy a version is refused on a single-record concept
  // (`SingleRecordProtected`): archiving the last live version, or discarding the
  // only-ever draft, would take the record the flag promises exists. Publish, new
  // version and restore stay — the lineage still grows and recovers normally.
  const protectedRecord = ctx.concept.singleRecord
  const navigate = useNavigate()
  const versionsQ = useQuery({
    queryKey: ["versions", recordId],
    queryFn: () => api.listVersions(recordId),
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
    mutationFn: () => api.newVersion(recordId),
    onSuccess: (d) => {
      refetch()
      navigate(recordHref(d.id))
    },
  })
  const approve = useMutation({
    mutationFn: (v: { id: string }) => api.approveVersion(v.id),
    onSuccess: refetch,
  })
  const withdraw = useMutation({
    mutationFn: (v: { id: string }) => api.withdrawApproval(v.id),
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
    mutationFn: (v: { id: string; version: number }) => api.archiveRecordVersion(v.id, v.version),
    onSuccess: refetch,
  })
  const restoreVersion = useMutation({
    mutationFn: (v: { id: string; version: number }) => api.restoreRecordVersion(v.id, v.version),
    onSuccess: refetch,
  })

  const err =
    newVersion.error ||
    approve.error ||
    withdraw.error ||
    discard.error ||
    archiveVersion.error ||
    restoreVersion.error

  return (
    <>
      {/* A container query, not a viewport one: the same list renders as a wide
          dashboard tile or a narrow column. Wide, it reads as the policy
          "Document History" table it replaces; narrow, each version stacks. */}
      <div className="divide-y divide-border @container">
        {versions.length === 0 && (
          <div className="px-6 py-2 text-sm text-muted-foreground">No versions yet.</div>
        )}
        {versions.length > 0 && (
          <div
            className={`${COLS} hidden py-2 pr-3 pl-6 text-xs font-medium text-muted-foreground @2xl:grid`}
          >
            <span>Version</span>
            <span>Date</span>
            <span>Change</span>
            <span>Written by</span>
            <span>Approved by</span>
          </div>
        )}
        {[...versions].reverse().map((v) => {
          const isHead = v.versionStatus === "published" && v.versionSeq === headSeq
          const isCurrent = v.id === current.id
          const h = historyOf(v, who)
          return (
            <div
              key={v.id}
              // The row you're viewing reads as active from its fill + bolder
              // label alone. pr-3, not px-6: the icon buttons carry ~9px of their
              // own padding, so a full 24px right inset reads as lopsided.
              className={`${COLS} items-start gap-y-0.5 py-1.5 pr-3 pl-6 ${
                isCurrent ? "bg-accent" : "hover:bg-accent/40"
              }`}
            >
              <button
                type="button"
                onClick={() => navigate(recordHref(v.id))}
                disabled={isCurrent}
                className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-1.5 py-1 text-left text-sm disabled:cursor-default hover:underline disabled:hover:no-underline"
              >
                <span
                  className={
                    isCurrent
                      ? "font-semibold text-foreground"
                      : "font-medium text-muted-foreground"
                  }
                >
                  {v.release.name ?? v.release.pending?.name ?? `v${v.versionSeq}`}
                </span>
                {v.release.pending ? (
                  <Badge tone="blue">Awaiting approval</Badge>
                ) : v.versionStatus === "draft" ? (
                  <Badge tone="amber">Draft</Badge>
                ) : isHead ? (
                  <Badge tone="green">Latest</Badge>
                ) : null}
                {v.release.historical && <Badge tone="gray">Imported</Badge>}
                {v.archivedAt && <Badge tone="gray">Archived</Badge>}
              </button>
              <div className="col-start-2 row-start-1 flex shrink-0 items-center justify-end gap-0.5 @2xl:col-start-6">
                {v.release.pending ? (
                  <>
                    {v.release.pending.approverId === ctx.myUserId && (
                      <>
                        <IconButton
                          aria-label={`Approve v${v.versionSeq}`}
                          title="Approve and publish"
                          disabled={approve.isPending}
                          onClick={() => approve.mutate({ id: v.id })}
                        >
                          <Check size={14} />
                        </IconButton>
                        <IconButton
                          aria-label={`Reject v${v.versionSeq}`}
                          title="Reject"
                          variant="danger"
                          onClick={() => setRejecting(v)}
                        >
                          <X size={14} />
                        </IconButton>
                      </>
                    )}
                    <IconButton
                      aria-label={`Withdraw v${v.versionSeq}`}
                      title="Withdraw the approval request"
                      disabled={withdraw.isPending}
                      onClick={() => withdraw.mutate({ id: v.id })}
                    >
                      <Undo2 size={14} />
                    </IconButton>
                  </>
                ) : v.versionStatus === "draft" ? (
                  <>
                    <IconButton
                      aria-label={`Publish v${v.versionSeq}`}
                      title="Publish this draft"
                      onClick={() => setModal({ mode: "publish", v })}
                    >
                      <Rocket size={14} />
                    </IconButton>
                    {!protectedRecord && (
                      <IconButton
                        aria-label={`Discard v${v.versionSeq}`}
                        title="Discard this draft"
                        variant="danger"
                        disabled={discard.isPending}
                        onClick={() => discard.mutate({ id: v.id })}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    )}
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
                  <>
                    {/* Signed off in Kahuna ⇒ its info is frozen (server refuses too). */}
                    {!v.release.approvedBy && (
                      <IconButton
                        aria-label={`Edit info of v${v.versionSeq}`}
                        title="Edit version info"
                        onClick={() => setModal({ mode: "info", v })}
                      >
                        <Pencil size={14} />
                      </IconButton>
                    )}
                    {!protectedRecord && (
                      <IconButton
                        aria-label={`Archive v${v.versionSeq}`}
                        title="Archive this version"
                        disabled={archiveVersion.isPending}
                        onClick={() => archiveVersion.mutate({ id: v.id, version: v.version })}
                      >
                        <Archive size={14} />
                      </IconButton>
                    )}
                  </>
                )}
              </div>
              <Cell className="hidden tabular-nums @2xl:col-start-2 @2xl:row-start-1 @2xl:block">
                {h.date}
              </Cell>
              <div className="col-span-2 row-start-2 min-w-0 text-sm @2xl:col-span-1 @2xl:col-start-3 @2xl:row-start-1 @2xl:py-1">
                {h.note ? (
                  <span className="whitespace-pre-wrap text-foreground/90">{h.note}</span>
                ) : (
                  <span className="text-muted-foreground/60 @2xl:inline hidden">—</span>
                )}
                {h.rejection && <div className="text-xs text-destructive">{h.rejection}</div>}
              </div>
              <Cell className="hidden @2xl:col-start-4 @2xl:row-start-1 @2xl:block">
                {h.author}
              </Cell>
              <Cell className="hidden @2xl:col-start-5 @2xl:row-start-1 @2xl:block">
                {h.approver}
              </Cell>
              {/* Narrow: date · author · approver as one muted line. */}
              {h.line && (
                <div className="col-span-2 row-start-3 text-xs text-muted-foreground @2xl:hidden">
                  {h.line}
                </div>
              )}
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
      {modal && (
        <ReleaseModal
          mode={modal.mode}
          version={modal.v}
          versions={versions}
          concept={ctx.concept}
          members={pickable}
          myUserId={ctx.myUserId}
          onClose={() => setModal(null)}
          onDone={refetch}
        />
      )}
      {rejecting && (
        <RejectModal v={rejecting} onClose={() => setRejecting(null)} onDone={refetch} />
      )}
    </>
  )
}

/** Shared column template: narrow = version | actions (the rest stacks below);
 *  wide = the Document History columns, actions last. */
const COLS =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 @2xl:grid-cols-[10rem_6.5rem_minmax(0,1fr)_9rem_9rem_5rem]"

/** One muted table cell; "—" when empty so a gap reads as "none", not "loading". */
function Cell({ className, children }: { className: string; children: string | null }) {
  return (
    <span className={`truncate py-1 text-sm text-muted-foreground ${className}`}>
      {children || <span className="text-muted-foreground/60">—</span>}
    </span>
  )
}

/** A version as a Document History row. Signed-in-Kahuna names win over
 *  recorded (imported/backfilled) ones; an open request shows who asked and
 *  who's been asked. */
function historyOf(v: RecordVersion, who: (userId: string | null) => string | null) {
  const r = v.release
  const pending = r.pending
  const date = v.versionStatus === "published" ? versionDate(v) : null
  const author = pending ? who(pending.requestedBy) : (who(r.publishedBy) ?? r.attributedAuthor)
  const approver = pending
    ? `${who(pending.approverId) ?? "?"} (pending)`
    : (who(r.approvedBy) ?? r.attributedApprover)
  const rejection =
    v.versionStatus === "draft" && !pending && r.lastRejection
      ? `Rejected by ${who(r.lastRejection.by) ?? "approver"}${r.lastRejection.reason ? `: ${r.lastRejection.reason}` : ""}`
      : null
  const line = [
    date,
    author,
    pending ? `awaiting ${who(pending.approverId)}` : approver ? `approved by ${approver}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
  return { date, author, approver, note: pending?.note ?? r.note, rejection, line }
}

/** Reject with an optional reason, shown to the requester on the draft. */
function RejectModal({
  v,
  onClose,
  onDone,
}: {
  v: RecordVersion
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState("")
  const reject = useMutation({
    mutationFn: () => api.rejectVersion(v.id, reason.trim() || null),
    onSuccess: () => {
      onDone()
      onClose()
    },
  })
  return (
    <Modal title={`Reject ${v.release.pending?.name ?? `v${v.versionSeq}`}`} onClose={onClose}>
      <div className="space-y-3">
        <Textarea
          value={reason}
          rows={3}
          placeholder="Reason (optional) — shown to the requester"
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex gap-2">
          <Button variant="destructive" onClick={() => reject.mutate()} disabled={reject.isPending}>
            <X size={15} />
            {reject.isPending ? "Rejecting…" : "Reject"}
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {reject.error && <p className="text-sm text-destructive">{reject.error.message}</p>}
      </div>
    </Modal>
  )
}
