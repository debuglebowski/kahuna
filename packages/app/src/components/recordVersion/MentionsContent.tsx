/**
 * The "Mentions" record panel: every document that `@`-mentions this record.
 *
 * Shaped after `ConnectedContent`'s inbound list — grouped headings, one link per
 * row, a concept badge — with one state fewer. `ConnectedContent` renders dangling
 * targets as muted italic rows; here there is nothing equivalent, because a source
 * the reader may not open is DROPPED server-side rather than placeholdered. Naming
 * it would confirm that a document they can't see references this record.
 *
 * Fetches its own data rather than riding `getRecordDetail`, matching the
 * Notes/Tasks/Files panels: that read is already the heaviest in the app, and most
 * record views never open this tab.
 */

import { useQuery } from "@tanstack/react-query"
import { AtSign } from "lucide-react"
import { Link } from "react-router-dom"
import { api, type BacklinkRef } from "../../lib/api"
import { Badge } from "../ui"
import type { RecordVersionCtx } from "./types"

const GROUP_LABEL: Record<BacklinkRef["source"], string> = {
  record: "Mentioned in records",
  task: "Mentioned in tasks",
}

function Row({ link }: { link: BacklinkRef }) {
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{link.label}</span>
      {link.fieldName && (
        <span className="shrink-0 text-muted-foreground text-xs">{link.fieldName}</span>
      )}
      {link.conceptName && (
        <span className="shrink-0">
          <Badge tone="blue">{link.conceptName}</Badge>
        </span>
      )}
    </>
  )
  // A task has no addressable URL yet, so its row is inert rather than a dead link.
  return link.href ? (
    <Link
      to={link.href}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
    >
      {body}
    </Link>
  ) : (
    <div className="flex items-center gap-2 px-2 py-1.5 text-sm">{body}</div>
  )
}

export function MentionsBody({ ctx }: { ctx: RecordVersionCtx }) {
  const recordId = ctx.recordVersion.recordId
  const { data, isPending } = useQuery({
    queryKey: ["backlinks", recordId],
    queryFn: () => api.listBacklinks(recordId),
  })

  if (isPending) return null
  const links = data ?? []
  if (links.length === 0) {
    return (
      <p className="px-2 py-1.5 text-muted-foreground text-sm">Nothing mentions this record yet.</p>
    )
  }

  const groups = (["record", "task"] as const)
    .map((source) => ({ source, rows: links.filter((l) => l.source === source) }))
    .filter((g) => g.rows.length > 0)

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.source} className="space-y-0.5">
          <p className="px-2 font-medium text-muted-foreground text-xs">{GROUP_LABEL[g.source]}</p>
          {g.rows.map((link, i) => (
            <Row key={`${link.source}-${link.href ?? i}`} link={link} />
          ))}
        </div>
      ))}
    </div>
  )
}

export const MentionsCount = ({ ctx }: { ctx: RecordVersionCtx }) => {
  const { data } = useQuery({
    queryKey: ["backlinks", ctx.recordVersion.recordId],
    queryFn: () => api.listBacklinks(ctx.recordVersion.recordId),
  })
  const n = data?.length ?? 0
  return n > 0 ? <span className="text-muted-foreground text-xs">{n}</span> : null
}

export const MentionsIcon = AtSign
