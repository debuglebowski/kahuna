import { useLiveQuery } from "@tanstack/react-db"
import { useMutation } from "@tanstack/react-query"
import { Archive, ArchiveRestore, Check, Pencil, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Textarea } from "@/components/ui/textarea"
import { relativeTime } from "../../lib/activity"
import type { Note } from "../../lib/api"
import { api } from "../../lib/api"
import { KEY, notesBySubject, useRegisterCollection } from "../../lib/collections"
import { Button, ConfirmDialog, IconButton } from "../ui"
import { MemberAvatar, memberLabel, type OrgMember } from "./AssigneePicker"
import { MarkdownView } from "./MarkdownView"

function NoteComposer({ onCreate }: { onCreate: (body: string) => Promise<unknown> }) {
  const [body, setBody] = useState("")
  const create = useMutation({
    mutationFn: () => onCreate(body.trim()),
    onSuccess: () => setBody(""),
  })
  return (
    <div className="space-y-2 p-4">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a note… (markdown supported)"
        rows={3}
      />
      <div className="flex items-center justify-between">
        {create.error ? (
          <span className="text-sm text-destructive">{(create.error as Error).message}</span>
        ) : (
          <span />
        )}
        <Button onClick={() => create.mutate()} disabled={!body.trim() || create.isPending}>
          <Check size={15} />
          {create.isPending ? "Adding…" : "Add note"}
        </Button>
      </div>
    </div>
  )
}

function NoteCard({
  note,
  canMutate,
  author,
  onSaved,
}: {
  note: Note
  canMutate: boolean
  author: OrgMember | undefined
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => setDraft(note.body), [note.body])

  const save = useMutation({
    mutationFn: () => api.updateNote(note.id, note.version, { body: draft }),
    onSuccess: () => {
      setEditing(false)
      onSaved()
    },
  })
  const archive = useMutation({
    mutationFn: () =>
      note.archivedAt
        ? api.restoreNote(note.id, note.version)
        : api.archiveNote(note.id, note.version),
    onSuccess: onSaved,
  })
  const del = useMutation({ mutationFn: () => api.deleteNote(note.id), onSuccess: onSaved })

  return (
    <div className={`px-4 py-3 ${note.archivedAt ? "opacity-60" : ""}`}>
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <MemberAvatar member={author} size={18} />
        <span className="font-medium text-foreground">{memberLabel(author)}</span>
        <span title={new Date(note.updatedAt).toLocaleString()}>
          {relativeTime(new Date(note.updatedAt))}
        </span>
        {note.archivedAt && <span className="italic">· archived</span>}
        {canMutate && !editing && (
          <span className="ml-auto flex items-center gap-1">
            <IconButton aria-label="Edit note" onClick={() => setEditing(true)}>
              <Pencil size={13} />
            </IconButton>
            <IconButton
              aria-label={note.archivedAt ? "Restore note" : "Archive note"}
              onClick={() => archive.mutate()}
            >
              {note.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            </IconButton>
            <IconButton aria-label="Delete note" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={13} />
            </IconButton>
          </span>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
          {save.error && (
            <p className="text-sm text-destructive">{(save.error as Error).message}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false)
                setDraft(note.body)
              }}
            >
              <X size={14} /> Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              <Check size={14} /> {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <MarkdownView>{note.body}</MarkdownView>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete note"
          message="Permanently delete this note? This can't be undone."
          confirmLabel="Delete"
          confirmVariant="danger"
          pending={del.isPending}
          error={del.error ? (del.error as Error).message : undefined}
          onConfirm={() => del.mutate()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}

/** Notes for an item (subjectId = record id). Any member may add; the
 *  author or an admin may edit/archive/delete. */
export function NotesPanel({
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
  const collection = notesBySubject(subjectId)
  useRegisterCollection(KEY.notes(subjectId), collection)
  const q = useLiveQuery((qb) => qb.from({ n: collection }), [subjectId, collection])
  const refetch = () => collection.utils.refetch()

  const byUser = new Map(members.map((m) => [m.userId, m]))
  const all = [...(q.data ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  const notes = showArchived ? all : all.filter((n) => !n.archivedAt)
  const archivedCount = all.length - all.filter((n) => !n.archivedAt).length

  return (
    <div>
      <NoteComposer onCreate={(body) => api.createNote(subjectId, body).then(refetch)} />
      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((s) => !s)}
          className="px-4 pb-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {showArchived ? "Hide" : "Show"} {archivedCount} archived
        </button>
      )}
      <div className="divide-y divide-border border-t border-border">
        {notes.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">No notes yet.</div>
        ) : (
          notes.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              author={n.createdBy ? byUser.get(n.createdBy) : undefined}
              canMutate={isAdmin || (!!myUserId && n.createdBy === myUserId)}
              onSaved={refetch}
            />
          ))
        )}
      </div>
    </div>
  )
}
