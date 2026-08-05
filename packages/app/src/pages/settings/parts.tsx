import { Archive, ArchiveRestore, Trash2 } from "lucide-react"
import type { ReactNode } from "react"
import { Badge, Button, Card, CardHeader } from "@/components/ui"

/** Inline success/error line shared by the settings forms. */
export function Feedback({
  ok,
  okText,
  error,
}: {
  ok?: boolean
  okText?: string
  error?: unknown
}) {
  if (error) {
    // Accepts EITHER a thrown error or an already-mapped string. Reading `.message`
    // alone silently discarded every caller that passed prose — a string has no
    // `.message`, so eight call sites which had carefully mapped their errors all
    // rendered "Something went wrong" instead. Found when the access floor guard's
    // explanation never reached the user.
    const text =
      typeof error === "string" ? error : ((error as Error)?.message ?? "Something went wrong.")
    return <p className="text-sm text-destructive">{text}</p>
  }
  if (ok) return <p className="text-sm text-green-600">{okText ?? "Saved."}</p>
  return null
}

/**
 * The red "Danger zone" card at the foot of a settings editor: archive/restore,
 * and optionally a permanent delete.
 *
 * Three editors had this hand-rolled — the tasks status/priority modals (which
 * already shared a local copy), Labels, and ConceptEditor — with the same Card,
 * header, `divide-y` rows and the same long destructive class string on the
 * delete button. `archiveHint` and `restoreError` are ReactNode because
 * ConceptEditor computes its hint from the concept's item count and Labels passes
 * a node for the error.
 *
 * Delete-only zones (Views, Organization, Profile) deliberately do NOT use this:
 * those are padded confirmation forms — a name to type, a password — sharing only
 * the red card shell, and fitting them here would need a `children` escape hatch
 * that hollows the component out.
 */
export function DangerZone({
  noun,
  archived,
  archiveHint,
  restoreHint = "Brings it back to pickers.",
  onArchive,
  onRestore,
  restorePending,
  restoreError,
  onDelete,
  deleteHint,
}: {
  noun: string
  archived: boolean
  archiveHint: ReactNode
  /** Overridable: what restoring actually brings it back to. */
  restoreHint?: ReactNode
  onArchive: () => void
  onRestore: () => void
  restorePending: boolean
  restoreError?: ReactNode
  /** Omit for archive-only zones (no delete row is rendered). */
  onDelete?: () => void
  deleteHint?: ReactNode
}) {
  return (
    <Card className="border-destructive/40">
      <CardHeader
        title={<span className="text-destructive">Danger zone</span>}
        action={archived ? <Badge tone="amber">Archived</Badge> : undefined}
      />
      <div className="divide-y divide-border">
        {archived ? (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Restore this {noun}</p>
              <p className="text-xs text-muted-foreground">{restoreHint}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={restorePending}
              onClick={onRestore}
            >
              <ArchiveRestore size={14} />
              {restorePending ? "Restoring…" : "Restore"}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Archive this {noun}</p>
              <p className="text-xs text-muted-foreground">{archiveHint}</p>
            </div>
            <Button variant="outline" size="sm" className="shrink-0" onClick={onArchive}>
              <Archive size={14} />
              Archive
            </Button>
          </div>
        )}
        {onDelete && (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Delete this {noun}</p>
              <p className="text-xs text-muted-foreground">{deleteHint}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 size={14} />
              Delete
            </Button>
          </div>
        )}
      </div>
      {restoreError && <p className="px-4 pb-3 text-sm text-destructive">{restoreError}</p>}
    </Card>
  )
}
