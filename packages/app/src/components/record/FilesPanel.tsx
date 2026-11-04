import { useLiveQuery } from "@tanstack/react-db"
import { useState } from "react"
import type { Field } from "../../lib/api"
import { filesBySubject, KEY, useRegisterCollection } from "../../lib/collections"
import { canMutateFile } from "../../lib/files"
import { FileDropSurface, FileDropZone, FileList } from "../files/FileList"
import { fileMoveTargets, MoveToProperty, PropertyTag } from "../files/FileProperties"
import type { OrgMember } from "./AssigneePicker"

/**
 * EVERY file on a record (subjectId = record id) — loose uploads AND the files
 * of its file properties, which are the same attachments. One storage, one list:
 * this panel is the "all files on this record" view, so nothing is ever split
 * between a property and here. A property file carries its property's name, and
 * anyone who can edit the record can move any file into a property, out of one,
 * or between them. Any member may upload; the uploader or an admin may
 * archive/restore/delete. Mirrors NotesPanel.
 */
export function FilesPanel({
  subjectId,
  myUserId,
  isAdmin,
  members,
  fields = [],
  onChanged,
}: {
  subjectId: string
  myUserId: string | undefined
  isAdmin: boolean
  members: ReadonlyArray<OrgMember>
  /** The record's field defs — its file properties are the move targets. */
  fields?: ReadonlyArray<Field>
  /** The host record view's refetch: a move changes a property's value. */
  onChanged?: () => void
}) {
  const [showArchived, setShowArchived] = useState(false)
  const collection = filesBySubject(subjectId)
  useRegisterCollection(KEY.files(subjectId), collection)
  const q = useLiveQuery((qb) => qb.from({ f: collection }))
  const refetch = () => {
    void collection.utils.refetch()
    onChanged?.()
  }

  const byUser = new Map(members.map((m) => [m.userId, m]))
  const all = [...(q.data ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  const files = showArchived ? all : all.filter((f) => !f.archivedAt)
  const archivedCount = all.filter((f) => f.archivedAt).length
  const viewer = { userId: myUserId, admin: isAdmin }

  const targets = fileMoveTargets(fields)

  // The whole panel takes a file drop, not just the dashed strip — dropping onto
  // the file list below it is the same intent. The strip stays as the visible
  // affordance and the click-to-browse target.
  // Files first, upload chrome last — same order as the dashboard widget, so the
  // two Files surfaces don't disagree about where the drop zone lives.
  return (
    <FileDropSurface owner={{ recordId: subjectId }} onUploaded={refetch}>
      <FileList
        files={files}
        byUser={byUser}
        canMutate={(f) => canMutateFile(f, viewer)}
        onChanged={refetch}
        tagOf={(f) => <PropertyTag file={f} fields={fields} />}
        actionsOf={(f) =>
          // Any writer may move (server-gated on the record); only archive/delete
          // are uploader-or-admin.
          targets.length > 0 && !f.archivedAt ? (
            <MoveToProperty file={f} targets={targets} onMoved={refetch} />
          ) : null
        }
      />
      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((s) => !s)}
          className="px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {showArchived ? "Hide" : "Show"} {archivedCount} archived
        </button>
      )}
      {/* No rule above it — the zone's dashed outline is separation enough. */}
      <div className="p-4">
        <FileDropZone owner={{ recordId: subjectId }} onUploaded={refetch} />
      </div>
    </FileDropSurface>
  )
}
