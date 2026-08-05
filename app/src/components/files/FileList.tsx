import { useMutation } from "@tanstack/react-query"
import {
  Archive,
  ArchiveRestore,
  Download,
  ExternalLink,
  File,
  FileImage,
  FileText,
  Trash2,
  UploadCloud,
} from "lucide-react"
import { type DragEvent, type ReactNode, useRef, useState } from "react"
import { relativeTime } from "../../lib/activity"
import { type Attachment, api, type FileOwner } from "../../lib/api"
import { useSession } from "../../lib/auth-client"
import { fileKind, formatBytes } from "../../lib/files"
import { useIsAdmin } from "../../pages/settings/SettingsLayout"
import { MemberAvatar, memberLabel, type OrgMember } from "../record/AssigneePicker"
import { ConfirmDialog, IconButton, Modal } from "../ui"

/**
 * The shared Files renderer — list rows or a thumbnail gallery — used by the
 * record version tile and the dashboard widget. Mutations (archive/restore/delete)
 * live on the row; the host owns the data and passes `onChanged` to refetch.
 * Opening a file uses the inline URL (the browser renders img/pdf natively);
 * the download icon forces a save.
 */

const KIND_ICON = { image: FileImage, pdf: FileText, doc: FileText, other: File } as const

/**
 * Who's looking, for the uploader-or-admin row actions. A hook so a host that has
 * no assembled record context (the dashboard widget) can still offer archive and
 * delete: it previously passed no `canMutate` at all, which defaulted to false and
 * silently made every widget read-only.
 */
export function useFileViewer(): { userId: string | undefined; admin: boolean } {
  const { data: session } = useSession()
  const { admin } = useIsAdmin()
  return { userId: session?.user.id, admin }
}

/** Can we show this in-page, and how? Only formats a browser renders natively —
 *  guessing wrong means an embed that silently shows nothing, so anything else
 *  gets an honest "no preview" with download/open instead. */
const previewKind = (f: Attachment): "image" | "pdf" | "text" | null => {
  const mime = f.mimeType ?? ""
  const kind = fileKind(mime, f.filename)
  if (kind === "image") return "image"
  if (kind === "pdf") return "pdf"
  // Plain text renders in an iframe; the doc bucket also holds .docx and .xlsx,
  // which do not.
  if (mime.startsWith("text/") || /\.(txt|md|csv|json|log)$/i.test(f.filename)) return "text"
  return null
}

/**
 * Full-size preview of one file, in a 90vw × 90vh modal. Everything renders from
 * the inline URL (same bytes as the download, `content-disposition: inline`).
 * Anything a browser can't display natively says so rather than showing an empty
 * frame, and offers download / open-in-new-tab instead.
 *
 * PDFs use `<object>`, NOT a sandboxed `<iframe>`: `sandbox=""` disables plugins,
 * which silently kills Chrome's built-in PDF viewer — the frame loads and then
 * renders a broken-document icon. Verified side by side. Text keeps the sandbox
 * (it renders fine there, and an uploaded `.html` served from our own origin would
 * otherwise run script with the app's session — there is no extension allowlist on
 * upload). `<object>` gives a PDF no script access to this document either way.
 */
function FilePreview({ file, onClose }: { file: Attachment; onClose: () => void }) {
  const kind = previewKind(file)
  return (
    <Modal
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate" title={file.filename}>
            {file.filename}
          </span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">
            {formatBytes(file.sizeBytes)}
          </span>
        </span>
      }
      onClose={onClose}
      size="wide"
      // In the title row, left of the close button: these act on the file being
      // shown, and putting them here leaves the whole bottom edge to the preview.
      actions={
        <>
          <a
            href={api.fileInlineUrl(file.id)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm font-normal text-muted-foreground transition hover:text-foreground"
          >
            <ExternalLink size={14} /> Open in new tab
          </a>
          <a
            href={api.fileDownloadUrl(file.id)}
            download={file.filename}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm font-normal text-muted-foreground transition hover:text-foreground"
          >
            <Download size={14} /> Download
          </a>
        </>
      }
    >
      {/* The modal is a fixed 90vh column, so the pane just claims what's left
          (`flex-1` + `min-h-0`). No viewport-relative cap of its own — that would
          fight the frame and reintroduce the letterboxing this is meant to fix. */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border border-border bg-muted/30">
        {kind === "image" ? (
          // Fill the pane, never crop: `object-contain` inside max-h/max-w-full
          // scales a big scan down to fit and leaves a small one at its own size.
          <img
            src={api.fileInlineUrl(file.id)}
            alt={file.filename}
            className="max-h-full max-w-full object-contain"
          />
        ) : kind === "pdf" ? (
          // No `sandbox` here — it would disable the PDF plugin and show a broken
          // -document icon instead of the file. `<object>` still can't script this
          // page. Its fallback body shows when there's no PDF viewer at all.
          <object
            data={api.fileInlineUrl(file.id)}
            type="application/pdf"
            aria-label={file.filename}
            className="h-full w-full rounded-lg bg-background"
          >
            <p className="px-6 py-16 text-center text-sm text-muted-foreground">
              This browser can't display PDFs inline — download it or open it in a new tab.
            </p>
          </object>
        ) : kind === "text" ? (
          <iframe
            src={api.fileInlineUrl(file.id)}
            title={file.filename}
            // Text renders fine sandboxed, and the sandbox matters: uploads accept
            // any extension, so an .html served from our origin would otherwise run
            // script with the app's session.
            sandbox=""
            className="h-full w-full rounded-lg bg-background"
          />
        ) : (
          <p className="px-6 py-16 text-center text-sm text-muted-foreground">
            No preview for this file type — download it to open in an app.
          </p>
        )}
      </div>
    </Modal>
  )
}

function FileActions({
  file,
  canMutate,
  onChanged,
}: {
  file: Attachment
  canMutate: boolean
  onChanged: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const archive = useMutation({
    mutationFn: () => (file.archivedAt ? api.restoreFile(file.id) : api.archiveFile(file.id)),
    onSuccess: onChanged,
  })
  const del = useMutation({ mutationFn: () => api.deleteFile(file.id), onSuccess: onChanged })
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <a
        href={api.fileDownloadUrl(file.id)}
        download={file.filename}
        aria-label="Download file"
        className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <Download size={13} />
      </a>
      {canMutate && (
        <>
          <IconButton
            aria-label={file.archivedAt ? "Restore file" : "Archive file"}
            onClick={() => archive.mutate()}
          >
            {file.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </IconButton>
          <IconButton aria-label="Delete file" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} />
          </IconButton>
        </>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete file"
          message={`Permanently delete "${file.filename}"? This can't be undone.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          pending={del.isPending}
          error={del.error ? (del.error as Error).message : undefined}
          onConfirm={() => del.mutate()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </span>
  )
}

export function FileList({
  files,
  variant = "list",
  byUser,
  canMutate,
  onChanged,
  emptyText = "No files yet.",
}: {
  files: ReadonlyArray<Attachment>
  variant?: "list" | "gallery"
  /** Uploader lookup; omit to hide the uploader column (the widget does). */
  byUser?: Map<string, OrgMember>
  canMutate?: (f: Attachment) => boolean
  onChanged?: () => void
  emptyText?: string
}) {
  const changed = onChanged ?? (() => {})
  // Above the early returns: hooks can't sit behind a conditional.
  const [preview, setPreview] = useState<Attachment | null>(null)
  // Resolve the open file from `files` each render, not from the click: after an
  // archive or refetch the array is new, and a stale copy would show outdated
  // metadata. A file that's gone (deleted, or archived out of view) resolves to
  // null, which closes the modal instead of previewing bytes that no longer exist.
  const previewing = preview ? (files.find((f) => f.id === preview.id) ?? null) : null
  const previewModal = previewing ? (
    <FilePreview file={previewing} onClose={() => setPreview(null)} />
  ) : null

  if (files.length === 0)
    return <div className="p-4 text-sm text-muted-foreground">{emptyText}</div>

  if (variant === "gallery")
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2 p-2">
        {previewModal}
        {files.map((f) => {
          const Icon = KIND_ICON[fileKind(f.mimeType, f.filename)]
          return (
            <div
              key={f.id}
              className={`group flex flex-col overflow-hidden rounded-lg border border-border ${f.archivedAt ? "opacity-60" : ""}`}
            >
              <button
                type="button"
                onClick={() => setPreview(f)}
                aria-label={`Preview ${f.filename}`}
                className="flex h-20 items-center justify-center bg-muted/40"
              >
                {fileKind(f.mimeType, f.filename) === "image" ? (
                  <img
                    src={api.fileInlineUrl(f.id)}
                    alt={f.filename}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <Icon size={26} className="text-muted-foreground" />
                )}
              </button>
              <div className="flex items-center gap-1 px-1.5 py-1">
                <span className="min-w-0 flex-1 truncate text-xs" title={f.filename}>
                  {f.filename}
                </span>
                <span className="opacity-60 transition group-hover:opacity-100 focus-within:opacity-100">
                  <FileActions file={f} canMutate={canMutate?.(f) ?? false} onChanged={changed} />
                </span>
              </div>
            </div>
          )
        })}
      </div>
    )

  return (
    <div className="divide-y divide-border">
      {previewModal}
      {files.map((f) => {
        const Icon = KIND_ICON[fileKind(f.mimeType, f.filename)]
        const uploader = byUser && f.createdBy ? byUser.get(f.createdBy) : undefined
        return (
          <div
            key={f.id}
            className={`group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40 ${f.archivedAt ? "opacity-60" : ""}`}
          >
            {/* Thumbnail for images, icon otherwise — a list of "pr-2304.png" rows
                is much easier to scan when you can see which one it is. Also the
                second way into the preview, so the click target isn't just the
                filename's text width. */}
            <button
              type="button"
              onClick={() => setPreview(f)}
              aria-label={`Preview ${f.filename}`}
              className="shrink-0"
            >
              {fileKind(f.mimeType, f.filename) === "image" ? (
                <img
                  src={api.fileInlineUrl(f.id)}
                  alt=""
                  loading="lazy"
                  className="h-9 w-9 rounded border border-border object-cover"
                />
              ) : (
                <span className="flex h-9 w-9 items-center justify-center rounded border border-border bg-muted/40">
                  <Icon size={16} className="text-muted-foreground" />
                </span>
              )}
            </button>
            <div className="min-w-0 flex-1">
              {/* Opens the preview rather than a new tab. "Open in new tab" and
                  "Download" both live in the preview, so nothing is lost. */}
              <button
                type="button"
                onClick={() => setPreview(f)}
                className="block max-w-full truncate text-left text-sm text-foreground hover:underline"
                title={f.filename}
              >
                {f.filename}
              </button>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>{formatBytes(f.sizeBytes)}</span>
                <span title={new Date(f.createdAt).toLocaleString()}>
                  · {relativeTime(new Date(f.createdAt))}
                </span>
                {byUser && (
                  <span className="flex items-center gap-1">
                    · <MemberAvatar member={uploader} size={14} /> {memberLabel(uploader)}
                  </span>
                )}
                {f.archivedAt && <span className="italic">· archived</span>}
              </p>
            </div>
            {/* Dimmed rather than hidden: hover-only actions are invisible on touch
                and undiscoverable everywhere else — the reason a row looked like it
                offered nothing but a download. Focus-within keeps them up for
                keyboard users mid-tab. */}
            <span className="opacity-60 transition group-hover:opacity-100 focus-within:opacity-100">
              <FileActions file={f} canMutate={canMutate?.(f) ?? false} onChanged={changed} />
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Upload plumbing shared by the dashed strip and the whole-surface drop target:
 * the mutation, the "files came in" handler, and the last error. Extracted as a
 * hook because a container that accepts drops needs exactly the same behaviour as
 * the button, and duplicating it would let the two drift.
 */
function useUpload(owner: FileOwner, onUploaded: () => void) {
  const [error, setError] = useState<string | null>(null)
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) await api.uploadFile(owner, file)
    },
    onSuccess: () => {
      setError(null)
      onUploaded()
    },
    onError: (e) => setError((e as Error).message),
  })
  const take = (list: FileList | null) => {
    const files = [...(list ?? [])]
    if (files.length > 0) upload.mutate(files)
  }
  return { take, error, pending: upload.isPending }
}

/** Does this drag actually carry files? A tile being rearranged on the canvas is
 *  also a drag, and treating it as an upload would light the whole widget up and
 *  swallow the drop that was meant to move the tile. */
const hasFiles = (e: DragEvent<HTMLElement>): boolean =>
  Array.from(e.dataTransfer.types ?? []).includes("Files")

/**
 * Makes an entire region a drop target, so "drag a file into the Files widget"
 * works when aimed anywhere in it — not only at the dashed strip, which is a thin
 * band across the top of a much larger tile. Renders `children` and overlays a
 * highlight while a file drag is over it.
 */
export function FileDropSurface({
  owner,
  onUploaded,
  className,
  children,
}: {
  owner: FileOwner
  onUploaded: () => void
  className?: string
  children?: ReactNode
}) {
  const { take, error, pending } = useUpload(owner, onUploaded)
  // Depth, not a boolean: dragging across a child fires dragleave on the one being
  // left before dragenter on the one being entered, so a flag would flicker off
  // mid-traverse and the highlight would strobe.
  const depth = useRef(0)
  const [over, setOver] = useState(false)

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop surface for file drags only; the keyboard/click path is the FileDropZone button inside it.
    <div
      className={`relative ${className ?? ""}`}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        depth.current += 1
        setOver(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        // Cancelling is what marks this a drop target; without it the browser
        // navigates to the file instead of handing it to the page.
        e.preventDefault()
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        take(e.dataTransfer.files)
      }}
    >
      {children}
      {(over || pending) && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-foreground">
          <span className="flex items-center gap-2">
            <UploadCloud size={16} aria-hidden />
            {pending ? "Uploading…" : "Drop to upload"}
          </span>
        </div>
      )}
      {error && <p className="mt-1.5 text-sm text-destructive">{error}</p>}
    </div>
  )
}

/**
 * The upload surface: a drop-zone that is also a click-to-browse button. Kept
 * alongside {@link FileDropSurface} because it is the visible affordance — the
 * surface is invisible until something is dragged over it, so removing the strip
 * would leave no hint that uploading is possible at all.
 * Uploads sequentially (small N), then signals the host once to refetch.
 */
export function FileDropZone({
  owner,
  onUploaded,
  children,
}: {
  /** A record, or a Files widget's own bucket. */
  owner: FileOwner
  onUploaded: () => void
  /** Custom idle content; default is the "drop files" hint. */
  children?: ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const { take, error, pending } = useUpload(owner, onUploaded)

  return (
    <div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          take(e.dataTransfer.files)
        }}
        className={`flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-sm transition ${
          dragging
            ? "border-primary bg-primary/5 text-foreground"
            : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
        }`}
      >
        <UploadCloud size={16} />
        {pending ? "Uploading…" : (children ?? "Drop files or click to upload")}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          take(e.target.files)
          e.target.value = ""
        }}
      />
      {error && <p className="mt-1.5 text-sm text-destructive">{error}</p>}
    </div>
  )
}
