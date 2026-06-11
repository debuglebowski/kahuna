import { useLiveQuery } from "@tanstack/react-db"
import {
  FileText,
  GitBranch,
  History,
  Link2,
  ListChecks,
  Rows3,
  StickyNote,
  Tags,
  Waypoints,
} from "lucide-react"
import { notesBySubject, tasksBySubject } from "../../lib/collections"
import type { ConceptCaps, TileContentKey } from "../../lib/instanceViews"
import { ActivityFeed } from "../item/ActivityFeed"
import { NotesPanel } from "../item/NotesPanel"
import { TaskList } from "../item/TaskList"
import { ConnectedActions, ConnectedBody } from "./ConnectedContent"
import { DetailsBody } from "./DetailsContent"
import { DocumentBody } from "./DocumentContent"
import { GraphActions, GraphBody } from "./GraphContent"
import { LabelsBody } from "./LabelsContent"
import type { InstanceCtx, TileContent } from "./types"
import { VersionsBody } from "./VersionsContent"

const hasRichText = (ctx: InstanceCtx): boolean => ctx.fields.some((f) => f.kind === "richtext")

/** The concept capabilities presets re-flow on — derived from ctx in one place
 *  so layout carve-outs and `available()` gates can't drift apart. */
export const capsOf = (ctx: InstanceCtx): ConceptCaps => ({
  versioned: ctx.concept.versioningEnabled,
  hasDocuments: hasRichText(ctx),
})

const Count = ({ n }: { n: number }) =>
  n > 0 ? <span className="text-xs font-normal text-muted-foreground">{n}</span> : null

// Counts piggyback on the same per-subject collections their panels read, so a
// closed tab costs one shared fetch — but they must NOT register for SSE
// refetch (the panel owns that key while mounted; double-registration would
// drop it on unmount).
const NotesCount = ({ ctx }: { ctx: InstanceCtx }) => {
  const collection = notesBySubject(ctx.instance.itemId)
  const q = useLiveQuery((qb) => qb.from({ n: collection }), [collection])
  return <Count n={(q.data ?? []).filter((x) => !x.archivedAt).length} />
}

const TasksCount = ({ ctx }: { ctx: InstanceCtx }) => {
  const collection = tasksBySubject(ctx.instance.itemId)
  const q = useLiveQuery((qb) => qb.from({ t: collection }), [collection])
  return <Count n={(q.data ?? []).filter((x) => !x.archivedAt).length} />
}

const ConnectedCount = ({ ctx }: { ctx: InstanceCtx }) => <Count n={ctx.related.length} />

/** The content catalog: everything a view tile (or tab) can hold. */
export const TILE_CONTENTS: Record<TileContentKey, TileContent> = {
  details: { title: "Details", Icon: Rows3, Body: DetailsBody },
  document: {
    title: "Document",
    Icon: FileText,
    available: hasRichText,
    Body: DocumentBody,
  },
  connected: {
    title: "Connections",
    Icon: Link2,
    Count: ConnectedCount,
    Actions: ConnectedActions,
    Body: ConnectedBody,
  },
  graph: {
    title: "Relationships",
    Icon: Waypoints,
    Actions: GraphActions,
    Body: GraphBody,
  },
  labels: { title: "Labels", Icon: Tags, Body: LabelsBody },
  versions: {
    title: "Versions",
    Icon: GitBranch,
    available: (ctx) => ctx.concept.versioningEnabled,
    Body: VersionsBody,
  },
  notes: {
    title: "Notes",
    Icon: StickyNote,
    Count: NotesCount,
    Body: ({ ctx }) => (
      <NotesPanel
        subjectId={ctx.instance.itemId}
        myUserId={ctx.myUserId}
        isAdmin={ctx.admin}
        members={ctx.members}
      />
    ),
  },
  tasks: {
    title: "Tasks",
    Icon: ListChecks,
    Count: TasksCount,
    Body: ({ ctx }) => (
      <TaskList
        subjectId={ctx.instance.itemId}
        myUserId={ctx.myUserId}
        isAdmin={ctx.admin}
        members={ctx.members}
      />
    ),
  },
  activity: {
    title: "Activity",
    Icon: History,
    Body: ({ ctx }) => <ActivityFeed subjectId={ctx.instance.itemId} fields={ctx.fields} />,
  },
}

export const availableContents = (
  contents: ReadonlyArray<TileContentKey>,
  ctx: InstanceCtx,
): TileContentKey[] => contents.filter((k) => TILE_CONTENTS[k].available?.(ctx) ?? true)
