import { useMutation } from "@tanstack/react-query"
import { FolderInput, Paperclip } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { type Attachment, api, type Field } from "../../lib/api"

/**
 * File-property chrome shared by the two "all files on this record" surfaces —
 * the record Files tile (FilesPanel) and a record-scoped Files widget: which
 * property a file belongs to, and a menu to move it into/out of one.
 */

/** File properties a file may move into: live, user-owned (a synced one is the
 *  connector's to fill — the server refuses it too). */
export const fileMoveTargets = (fields: ReadonlyArray<Field>): ReadonlyArray<Field> =>
  fields.filter((f) => f.kind === "file" && !f.archivedAt && !f.managedBy)

/** "· 📎 Attachments" after a property file's metadata; nothing for a loose file. */
export function PropertyTag({ file, fields }: { file: Attachment; fields: ReadonlyArray<Field> }) {
  if (!file.fieldId) return null
  const name = fields.find((f) => f.id === file.fieldId)?.name ?? "removed property"
  return (
    <span className="inline-flex items-center gap-1 text-foreground/80">
      · <Paperclip size={11} /> {name}
    </span>
  )
}

/** "Move to…" — into one of the record's file properties, or back to a loose
 *  file. Into a single-file property it replaces that property's current file
 *  (archived, restorable), which the menu says rather than surprising anyone. */
export function MoveToProperty({
  file,
  targets,
  onMoved,
}: {
  file: Attachment
  targets: ReadonlyArray<Field>
  onMoved: () => void
}) {
  const move = useMutation({
    mutationFn: (fieldId: string | null) => api.moveFile(file.id, fieldId),
    onSettled: onMoved,
  })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Move to property"
        className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <FolderInput size={13} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Move to property
        </DropdownMenuLabel>
        {targets.map((t) => (
          <DropdownMenuItem
            key={t.id}
            disabled={t.id === file.fieldId}
            onSelect={() => move.mutate(t.id)}
          >
            {t.name}
            {!t.config.multiple && (
              <span className="ml-auto text-xs text-muted-foreground">replaces</span>
            )}
          </DropdownMenuItem>
        ))}
        {file.fieldId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => move.mutate(null)}>
              Remove from property
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
