import { useLiveQuery } from "@tanstack/react-db"
import { useState } from "react"
import { filesBySubject, KEY, useRegisterCollection } from "../../lib/collections"
import { FileDropSurface, FileDropZone, FileList } from "../files/FileList"
import type { OrgMember } from "./AssigneePicker"

/** Files for a record (subjectId = record id). Any member may upload; the
 *  uploader or an admin may archive/restore/delete. Mirrors NotesPanel. */
export function FilesPanel({
  subjectId,
  myUserId,
  isAdmin,
  members,
}: {
  subjectId: string
  myUserId: string | undefined
  isAdmin: boolean
  members: ReadonlyArray<OrgMember>
}) {
  const [showArchived, setShowArchived] = useState(false)
  const collection = filesBySubject(subjectId)
  useRegisterCollection(KEY.files(subjectId), collection)
  const q = useLiveQuery((qb) => qb.from({ f: collection }), [subjectId, collection])
  const refetch = () => collection.utils.refetch()

  const byUser = new Map(members.map((m) => [m.userId, m]))
  const all = [...(q.data ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  const files = showArchived ? all : all.filter((f) => !f.archivedAt)
  const archivedCount = all.filter((f) => f.archivedAt).length

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
        canMutate={(f) => isAdmin || (!!myUserId && f.createdBy === myUserId)}
        onChanged={refetch}
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
