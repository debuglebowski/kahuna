import { useMutation } from "@tanstack/react-query"
import { Archive, ArrowDown, ArrowUp, Download, File, FileImage, FileText } from "lucide-react"
import type { Field, FileRef, RecordVersion } from "../../lib/api"
import { api } from "../../lib/api"
import { canMutateFile, fileKind, fileRefsOf, formatBytes } from "../../lib/files"
import { FileDropZone } from "../files/FileList"
import { IconButton } from "../ui"

const KIND_ICON = { image: FileImage, pdf: FileText, doc: FileText, other: File } as const

/**
 * Editor for one file PROPERTY on the record details: its files in order, with
 * upload, remove and (multi-file) reorder. The files are the record's own
 * attachments — the same rows the Files panel lists — so nothing here stores
 * anything new: upload targets the record with `?field=`, remove ARCHIVES (soft,
 * restorable from the Files panel), reorder sets positions.
 *
 * Rights mirror the server exactly, so no button 403s: upload and reorder for
 * anyone who may write the record; remove for the uploader or an admin.
 *
 * Not gated on the VERSION being editable: files hang off the record lineage and
 * survive re-publishes, exactly like the Files panel. A synced (integration-
 * managed) property or an archived record is read-only.
 */
export function FileFieldEditor({
  field,
  recordVersion,
  viewer,
  onChanged,
}: {
  field: Field
  recordVersion: RecordVersion
  viewer: { userId: string | undefined; admin: boolean }
  onChanged: () => void
}) {
  const files = fileRefsOf(recordVersion.state[field.id])
  const multiple = !!field.config.multiple
  const readOnly = !!field.managedBy || !!recordVersion.archivedAt

  const archive = useMutation({
    mutationFn: (id: string) => api.archiveFile(id),
    onSettled: onChanged,
  })
  const reorder = useMutation({
    mutationFn: (ids: ReadonlyArray<string>) =>
      api.reorderFieldFiles(recordVersion.recordId, field.id, ids),
    onSettled: onChanged,
  })
  const move = (from: number, to: number) => {
    const ids = files.map((f) => f.id)
    const [moved] = ids.splice(from, 1)
    if (!moved) return
    ids.splice(to, 0, moved)
    reorder.mutate(ids)
  }
  const error = (archive.error ?? reorder.error) as Error | null

  return (
    <div className="flex flex-col items-stretch gap-1.5 text-left">
      {files.map((f, i) => (
        <FileRow
          key={f.id}
          file={f}
          canRemove={!readOnly && canMutateFile(f, viewer)}
          onRemove={() => archive.mutate(f.id)}
          onUp={!readOnly && multiple && i > 0 ? () => move(i, i - 1) : undefined}
          onDown={!readOnly && multiple && i < files.length - 1 ? () => move(i, i + 1) : undefined}
          busy={archive.isPending || reorder.isPending}
        />
      ))}
      {files.length === 0 && readOnly && <span className="text-muted-foreground">—</span>}
      {!readOnly && (
        <FileDropZone
          owner={{ recordId: recordVersion.recordId, fieldId: field.id }}
          onUploaded={onChanged}
          multiple={multiple}
        >
          {multiple ? "Add files" : files.length > 0 ? "Replace file" : "Add a file"}
        </FileDropZone>
      )}
      {error && <p className="text-xs text-destructive">{error.message}</p>}
    </div>
  )
}

function FileRow({
  file,
  canRemove,
  onRemove,
  onUp,
  onDown,
  busy,
}: {
  file: FileRef
  canRemove: boolean
  onRemove: () => void
  onUp?: () => void
  onDown?: () => void
  busy: boolean
}) {
  const kind = fileKind(file.mimeType, file.filename)
  const Icon = KIND_ICON[kind]
  return (
    <div className="group flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
      {kind === "image" ? (
        <img
          src={api.fileInlineUrl(file.id)}
          alt=""
          loading="lazy"
          className="h-7 w-7 shrink-0 rounded border border-border object-cover"
        />
      ) : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border bg-muted/40">
          <Icon size={14} className="text-muted-foreground" />
        </span>
      )}
      <a
        href={api.fileInlineUrl(file.id)}
        target="_blank"
        rel="noreferrer"
        title={file.filename}
        className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
      >
        {file.filename}
      </a>
      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
      {/* Dimmed, not hidden — hover-only actions are invisible on touch. */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-60 transition group-hover:opacity-100 focus-within:opacity-100">
        {onUp && (
          <IconButton aria-label={`Move ${file.filename} up`} onClick={onUp} disabled={busy}>
            <ArrowUp size={13} />
          </IconButton>
        )}
        {onDown && (
          <IconButton aria-label={`Move ${file.filename} down`} onClick={onDown} disabled={busy}>
            <ArrowDown size={13} />
          </IconButton>
        )}
        <a
          href={api.fileDownloadUrl(file.id)}
          download={file.filename}
          aria-label={`Download ${file.filename}`}
          className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <Download size={13} />
        </a>
        {canRemove && (
          // Archive, not purge: a property's file can come back from the Files
          // panel's "show archived". Purge stays a deliberate act there.
          <IconButton aria-label={`Remove ${file.filename}`} onClick={onRemove} disabled={busy}>
            <Archive size={13} />
          </IconButton>
        )}
      </span>
    </div>
  )
}
