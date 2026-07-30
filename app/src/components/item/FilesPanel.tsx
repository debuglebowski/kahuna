import { useLiveQuery } from "@tanstack/react-db"
import { useState } from "react"
import { filesBySubject, KEY, useRegisterCollection } from "../../lib/collections"
import { FileDropZone, FileList } from "../files/FileList"
import type { OrgMember } from "./AssigneePicker"

/** Files for an item (subjectId = item lineage id). Any member may upload; the
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

  return (
    <div>
      <div className="p-4">
        <FileDropZone owner={{ itemId: subjectId }} onUploaded={refetch} />
      </div>
      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((s) => !s)}
          className="px-4 pb-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {showArchived ? "Hide" : "Show"} {archivedCount} archived
        </button>
      )}
      <div className="border-t border-border">
        <FileList
          files={files}
          byUser={byUser}
          canMutate={(f) => isAdmin || (!!myUserId && f.createdBy === myUserId)}
          onChanged={refetch}
        />
      </div>
    </div>
  )
}
