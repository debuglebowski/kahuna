import { useMutation } from "@tanstack/react-query"
import {
  Archive,
  ArchiveRestore,
  Download,
  File,
  FileImage,
  FileText,
  Trash2,
  UploadCloud,
} from "lucide-react"
import { type ReactNode, useRef, useState } from "react"
import { relativeTime } from "../../lib/activity"
import { type Attachment, api } from "../../lib/api"
import { fileKind, formatBytes } from "../../lib/files"
import { MemberAvatar, memberLabel, type OrgMember } from "../item/AssigneePicker"
import { ConfirmDialog, IconButton } from "../ui"

/**
 * The shared Files renderer — list rows or a thumbnail gallery — used by the
 * instance tile and the dashboard widget. Mutations (archive/restore/delete)
 * live on the row; the host owns the data and passes `onChanged` to refetch.
 * Opening a file uses the inline URL (the browser renders img/pdf natively);
 * the download icon forces a save.
 */

const KIND_ICON = { image: FileImage, pdf: FileText, doc: FileText, other: File } as const

const openHref = (f: Attachment): string =>
  fileKind(f.mimeType, f.filename) === "other" ? api.fileDownloadUrl(f.id) : api.fileInlineUrl(f.id)

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
  if (files.length === 0)
    return <div className="p-4 text-sm text-muted-foreground">{emptyText}</div>

  if (variant === "gallery")
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2 p-2">
        {files.map((f) => {
          const Icon = KIND_ICON[fileKind(f.mimeType, f.filename)]
          return (
            <div
              key={f.id}
              className={`group flex flex-col overflow-hidden rounded-lg border border-border ${f.archivedAt ? "opacity-60" : ""}`}
            >
              <a
                href={openHref(f)}
                target="_blank"
                rel="noreferrer"
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
              </a>
              <div className="flex items-center gap-1 px-1.5 py-1">
                <span className="min-w-0 flex-1 truncate text-xs" title={f.filename}>
                  {f.filename}
                </span>
                <span className="opacity-0 transition group-hover:opacity-100">
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
      {files.map((f) => {
        const Icon = KIND_ICON[fileKind(f.mimeType, f.filename)]
        const uploader = byUser && f.createdBy ? byUser.get(f.createdBy) : undefined
        return (
          <div
            key={f.id}
            className={`group flex items-center gap-2.5 px-4 py-2 ${f.archivedAt ? "opacity-60" : ""}`}
          >
            <Icon size={16} className="shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <a
                href={openHref(f)}
                target="_blank"
                rel="noreferrer"
                className="block truncate text-sm text-foreground hover:underline"
                title={f.filename}
              >
                {f.filename}
              </a>
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
            <span className="opacity-0 transition group-hover:opacity-100">
              <FileActions file={f} canMutate={canMutate?.(f) ?? false} onChanged={changed} />
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The upload surface: a drop-zone that is also a click-to-browse button.
 * Uploads sequentially (small N), then signals the host once to refetch.
 */
export function FileDropZone({
  itemId,
  onUploaded,
  children,
}: {
  itemId: string
  onUploaded: () => void
  /** Custom idle content; default is the "drop files" hint. */
  children?: ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) await api.uploadFile(itemId, file)
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
        {upload.isPending ? "Uploading…" : (children ?? "Drop files or click to upload")}
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
