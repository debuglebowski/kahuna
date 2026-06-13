import {
  Activity,
  BarChart3,
  CalendarDays,
  Files,
  GanttChart,
  Gauge,
  Link2,
  ListChecks,
  type LucideIcon,
  Megaphone,
  SquareKanban,
  StickyNote,
  Table,
  Target,
  TrendingUp,
  TriangleAlert,
  Users,
} from "lucide-react"
import type { ReactNode } from "react"
import type { DashboardWidget } from "./api"
import { cn } from "./utils"

/**
 * Catalog of every dashboard widget type — the single source of truth for the
 * Add-widget gallery (label, blurb, search keywords, icon, a static preview
 * illustration, and which section it falls under for each of the three
 * groupings). The previews are pure CSS mockups (no data, no live widget) that
 * sketch each widget's shape, so the gallery stays fast and renders before any
 * concept is picked.
 */

export type GroupBy = "intent" | "source" | "scope"

/** The group-by choices, in dropdown order. */
export const GROUP_BY_OPTIONS: ReadonlyArray<{ key: GroupBy; label: string }> = [
  { key: "intent", label: "By intent" },
  { key: "source", label: "By source" },
  { key: "scope", label: "By scope" },
]

/** Ordered section headers per grouping (the gallery renders sections in this
 *  order, skipping any that end up empty). */
export const GROUP_SECTIONS: Record<GroupBy, readonly string[]> = {
  intent: ["Numbers & goals", "Collections", "Workspace", "Page content"],
  source: ["Concept data", "Event log", "Workspace (org-wide)", "Static content"],
  scope: ["Concept-scoped", "Workspace & page"],
}

export interface WidgetMeta {
  type: DashboardWidget["type"]
  label: string
  description: string
  /** Extra synonyms / use-cases matched by the gallery search box. */
  keywords: readonly string[]
  icon: LucideIcon
  /** Section this widget belongs to under each grouping (keys match GROUP_SECTIONS). */
  groups: Record<GroupBy, string>
  Preview: () => ReactNode
}

// ── Preview primitives ──────────────────────────────────────────────────────
// Tiny tokenized shapes the per-widget previews compose. Muted by default; the
// previews layer accent fills (primary/info/success/warning) on top via `cn`.

const Frame = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div
    className={cn(
      "flex aspect-[5/3] w-full flex-col gap-1.5 overflow-hidden rounded-md border bg-muted/30 p-2",
      className,
    )}
  >
    {children}
  </div>
)

const Line = ({ className }: { className?: string }) => (
  <div className={cn("h-1.5 rounded-full bg-muted-foreground/25", className)} />
)
const Dot = ({ className }: { className?: string }) => (
  <div className={cn("size-3 shrink-0 rounded-full bg-muted-foreground/30", className)} />
)
const Sq = ({ className }: { className?: string }) => (
  <div className={cn("size-3 shrink-0 rounded-[3px] bg-muted-foreground/30", className)} />
)
const Card = ({ className }: { className?: string }) => (
  <div className={cn("rounded bg-muted-foreground/20", className)} />
)

// ── Per-widget previews ───────────────────────────────────────────────────────

const MetricPreview = () => (
  <Frame className="items-start justify-center gap-1">
    <span className="origin-left text-2xl leading-none font-semibold tracking-tight text-foreground/70 transition-transform duration-300 ease-out group-hover:scale-110">
      1,284
    </span>
    <span className="rounded bg-success/15 px-1 py-0.5 text-[9px] font-medium text-success">
      +12% ▲
    </span>
  </Frame>
)

const GoalPreview = () => (
  <Frame className="justify-center gap-2">
    <span className="text-xl leading-none font-semibold text-foreground/70">68%</span>
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/15">
      <div className="h-full w-2/3 rounded-full bg-primary/60 transition-[width] duration-500 ease-out group-hover:w-[88%]" />
    </div>
  </Frame>
)

const ListPreview = () => (
  <Frame className="justify-center gap-1.5">
    {[
      { lead: "w-1/3", rest: ["w-1/4", "w-1/6"], delay: "delay-0" },
      { lead: "w-1/4", rest: ["w-1/3", "w-1/5"], delay: "delay-75" },
      { lead: "w-1/3", rest: ["w-1/5", "w-1/4"], delay: "delay-100" },
      { lead: "w-1/5", rest: ["w-1/4", "w-1/6"], delay: "delay-150" },
    ].map((row) => (
      <div key={`${row.lead}-${row.rest.join("-")}`} className="flex gap-2">
        <Line
          className={cn(
            row.lead,
            "bg-primary/45 transition-[width] duration-300 ease-out group-hover:w-3/4",
            row.delay,
          )}
        />
        {row.rest.map((w) => (
          <Line key={w} className={w} />
        ))}
      </div>
    ))}
  </Frame>
)

const BreakdownPreview = () => (
  <Frame className="flex-row items-end gap-1.5">
    {[
      ["h-1/3", "bg-info/55", "delay-0"],
      ["h-2/3", "bg-primary/55", "delay-75"],
      ["h-1/2", "bg-success/55", "delay-100"],
      ["h-full", "bg-warning/60", "delay-150"],
      ["h-2/5", "bg-destructive/45", "delay-200"],
    ].map(([h, color, delay]) => (
      <div
        key={h}
        className={cn(
          "w-full origin-bottom rounded-t-sm transition-transform duration-300 ease-out group-hover:scale-y-110",
          h,
          color,
          delay,
        )}
      />
    ))}
  </Frame>
)

const TrendPreview = () => (
  <Frame className="flex-row items-end gap-1">
    {[
      ["h-1/4", "bg-primary/25", "delay-0"],
      ["h-2/5", "bg-primary/30", "delay-75"],
      ["h-1/3", "bg-primary/35", "delay-100"],
      ["h-1/2", "bg-primary/45", "delay-150"],
      ["h-2/3", "bg-primary/55", "delay-200"],
      ["h-3/5", "bg-primary/60", "delay-300"],
      ["h-full", "bg-primary/70", "delay-300"],
    ].map(([h, color, delay]) => (
      <div
        key={h}
        className={cn(
          "w-full origin-bottom rounded-t-sm transition-transform duration-300 ease-out group-hover:scale-y-110",
          h,
          color,
          delay,
        )}
      />
    ))}
  </Frame>
)

const AttentionPreview = () => (
  <Frame className="justify-center gap-2">
    {[
      ["w-1/2", "bg-warning/70", "delay-0"],
      ["w-2/3", "bg-destructive/60", "delay-100"],
      ["w-1/2", "bg-warning/70", "delay-200"],
    ].map(([w, color, delay], i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: two rows share a width, so index disambiguates
      <div key={`${w}-${i}`} className="flex items-center gap-2">
        <div
          className={cn(
            "size-2.5 shrink-0 rounded-full transition-transform duration-200 ease-out group-hover:scale-150",
            color,
            delay,
          )}
        />
        <Line className={w} />
      </div>
    ))}
  </Frame>
)

const ActivityPreview = () => (
  <Frame className="justify-center gap-2">
    {[
      ["w-3/4", "bg-info/60", "delay-0"],
      ["w-1/2", "bg-primary/60", "delay-100"],
      ["w-2/3", "bg-success/60", "delay-200"],
    ].map(([w, color, delay]) => (
      <div key={w} className="flex items-center gap-2">
        <Dot
          className={cn(
            "size-2.5 transition-transform duration-200 ease-out group-hover:scale-150",
            color,
            delay,
          )}
        />
        <Line className={w} />
      </div>
    ))}
  </Frame>
)

const TasksPreview = () => (
  <Frame className="justify-center gap-2">
    {[
      ["w-2/3", "bg-success/60", "delay-0"],
      ["w-1/2", "bg-primary/55", "delay-100"],
      ["w-3/4", "bg-muted-foreground/30", "delay-200"],
    ].map(([w, color, delay]) => (
      <div key={w} className="flex items-center gap-2">
        <Sq
          className={cn(
            "size-2.5 transition-transform duration-200 ease-out group-hover:scale-125",
            color,
            delay,
          )}
        />
        <Line className={w} />
      </div>
    ))}
  </Frame>
)

const MembersPreview = () => (
  <Frame className="items-center justify-center">
    <div className="flex -space-x-1.5">
      {[
        ["bg-primary/45", "group-hover:-translate-x-2"],
        ["bg-info/45", "group-hover:-translate-x-0.5"],
        ["bg-success/45", "group-hover:translate-x-0.5"],
        ["bg-warning/45", "group-hover:translate-x-2"],
      ].map(([color, shift]) => (
        <div
          key={color}
          className={cn(
            "size-6 rounded-full border-2 border-background transition-transform duration-300 ease-out",
            color,
            shift,
          )}
        />
      ))}
    </div>
  </Frame>
)

const WelcomePreview = () => (
  <Frame className="justify-center gap-2">
    <Line className="h-2.5 w-1/2 bg-primary/55 transition-[width] duration-300 ease-out group-hover:w-2/3" />
    <Line className="w-3/4" />
  </Frame>
)

const ShortcutsPreview = () => (
  <Frame className="justify-center gap-2">
    {[
      ["w-2/3", "bg-primary/55", "delay-0"],
      ["w-3/4", "bg-info/55", "delay-100"],
      ["w-1/2", "bg-success/55", "delay-200"],
    ].map(([w, color, delay]) => (
      <div key={w} className="flex items-center gap-2">
        <Sq
          className={cn(
            "size-2.5 transition-transform duration-200 ease-out group-hover:scale-125",
            color,
            delay,
          )}
        />
        <Line className={w} />
      </div>
    ))}
  </Frame>
)

const NotePreview = () => (
  <Frame className="justify-center gap-1.5">
    <Line className="w-full" />
    <Line className="w-full" />
    <Line className="w-4/5" />
    <Line className="w-1/2 transition-[width] duration-300 ease-out group-hover:w-4/5" />
  </Frame>
)

const KanbanPreview = () => (
  <Frame className="flex-row gap-1.5">
    {[
      { color: "bg-info/50", cards: ["h-1/3", "h-1/4"], delay: "delay-0" },
      { color: "bg-warning/50", cards: ["h-1/2"], delay: "delay-100" },
      { color: "bg-success/50", cards: ["h-1/4", "h-1/3"], delay: "delay-200" },
    ].map((col) => (
      <div key={col.color} className="flex flex-1 flex-col gap-1">
        {col.cards.map((h) => (
          <Card
            key={h}
            className={cn(
              "w-full transition-transform duration-300 ease-out group-hover:-translate-y-1",
              h,
              col.color,
              col.delay,
            )}
          />
        ))}
      </div>
    ))}
  </Frame>
)

const CALENDAR_CELLS = Array.from({ length: 20 }, (_, i) => i)
const CALENDAR_PRIMARY = new Set([1, 12, 18])
const CALENDAR_INFO = new Set([3, 9])
const CALENDAR_SUCCESS = new Set([6, 16])
const CalendarPreview = () => (
  <Frame>
    <div className="grid flex-1 grid-cols-5 grid-rows-4 gap-1">
      {CALENDAR_CELLS.map((n) => {
        const accent = CALENDAR_PRIMARY.has(n)
          ? "bg-primary/45"
          : CALENDAR_INFO.has(n)
            ? "bg-info/45"
            : CALENDAR_SUCCESS.has(n)
              ? "bg-success/45"
              : null
        return (
          <div
            key={n}
            className={cn(
              "rounded-[2px]",
              accent ?? "bg-muted-foreground/15",
              accent && "transition-transform duration-200 ease-out group-hover:scale-125",
            )}
          />
        )
      })}
    </div>
  </Frame>
)

const GanttPreview = () => (
  <Frame className="justify-center gap-1.5">
    {[
      ["ml-0", "w-1/2", "bg-primary/55", "delay-0"],
      ["ml-[20%]", "w-2/5", "bg-info/55", "delay-100"],
      ["ml-[10%]", "w-3/5", "bg-success/55", "delay-200"],
      ["ml-[45%]", "w-1/3", "bg-warning/60", "delay-300"],
    ].map(([ml, w, color, delay]) => (
      <div
        key={`${ml}-${w}`}
        className={cn(
          "h-1.5 rounded-full transition-transform duration-300 ease-out group-hover:translate-x-1.5",
          ml,
          w,
          color,
          delay,
        )}
      />
    ))}
  </Frame>
)

const FilesPreview = () => (
  <Frame className="justify-center gap-2">
    {[
      ["w-2/3", "bg-info/55", "delay-0"],
      ["w-3/4", "bg-primary/50", "delay-100"],
      ["w-1/2", "bg-success/50", "delay-200"],
    ].map(([w, color, delay]) => (
      <div key={w} className="flex items-center gap-2">
        <div
          className={cn(
            "h-3 w-2.5 shrink-0 rounded-[2px] transition-transform duration-200 ease-out group-hover:scale-110",
            color,
            delay,
          )}
        />
        <Line className={w} />
      </div>
    ))}
  </Frame>
)

// ── Catalog ───────────────────────────────────────────────────────────────────
// Order mirrors the former dropdown.

export const WIDGET_CATALOG: ReadonlyArray<WidgetMeta> = [
  {
    type: "metric",
    label: "Metric",
    description: "A single headline number from your data.",
    keywords: ["number", "count", "sum", "stat", "kpi", "total", "aggregate", "average", "figure"],
    icon: Gauge,
    groups: { intent: "Numbers & goals", source: "Concept data", scope: "Concept-scoped" },
    Preview: MetricPreview,
  },
  {
    type: "goal",
    label: "Goal",
    description: "Track progress toward a target.",
    keywords: [
      "target",
      "progress",
      "objective",
      "quota",
      "okr",
      "completion",
      "percent",
      "milestone",
    ],
    icon: Target,
    groups: { intent: "Numbers & goals", source: "Concept data", scope: "Concept-scoped" },
    Preview: GoalPreview,
  },
  {
    type: "list",
    label: "List / Table",
    description: "A table of matching items.",
    keywords: ["table", "rows", "records", "grid", "spreadsheet", "items", "data"],
    icon: Table,
    groups: { intent: "Collections", source: "Concept data", scope: "Concept-scoped" },
    Preview: ListPreview,
  },
  {
    type: "breakdown",
    label: "Breakdown",
    description: "Counts grouped by a field, as a chart.",
    keywords: [
      "group",
      "chart",
      "bar",
      "pie",
      "donut",
      "distribution",
      "category",
      "segment",
      "counts",
    ],
    icon: BarChart3,
    groups: { intent: "Numbers & goals", source: "Concept data", scope: "Concept-scoped" },
    Preview: BreakdownPreview,
  },
  {
    type: "attention",
    label: "Attention",
    description: "Items that need a look — stale or flagged.",
    keywords: ["stale", "flagged", "review", "overdue", "alert", "warning", "follow up", "triage"],
    icon: TriangleAlert,
    groups: { intent: "Collections", source: "Concept data", scope: "Concept-scoped" },
    Preview: AttentionPreview,
  },
  {
    type: "trend",
    label: "Trend",
    description: "A value over time from the event log.",
    keywords: ["time", "line", "history", "growth", "series", "over time", "timeseries", "chart"],
    icon: TrendingUp,
    groups: { intent: "Numbers & goals", source: "Event log", scope: "Concept-scoped" },
    Preview: TrendPreview,
  },
  {
    type: "activity",
    label: "Activity",
    description: "A live feed of recent changes.",
    keywords: [
      "feed",
      "recent",
      "changes",
      "audit",
      "history",
      "events",
      "stream",
      "updates",
      "log",
    ],
    icon: Activity,
    groups: { intent: "Workspace", source: "Event log", scope: "Concept-scoped" },
    Preview: ActivityPreview,
  },
  {
    type: "tasks",
    label: "Tasks",
    description: "Your tasks across the workspace.",
    keywords: ["todo", "checklist", "assignments", "work", "issues", "to-do", "my tasks"],
    icon: ListChecks,
    groups: { intent: "Workspace", source: "Workspace (org-wide)", scope: "Workspace & page" },
    Preview: TasksPreview,
  },
  {
    type: "members",
    label: "Members",
    description: "People in this workspace.",
    keywords: ["people", "users", "team", "directory", "staff", "roster", "members"],
    icon: Users,
    groups: { intent: "Workspace", source: "Workspace (org-wide)", scope: "Workspace & page" },
    Preview: MembersPreview,
  },
  {
    type: "welcome",
    label: "Welcome",
    description: "A banner to greet the team.",
    keywords: ["banner", "greeting", "intro", "hero", "header", "message", "announcement"],
    icon: Megaphone,
    groups: { intent: "Page content", source: "Workspace (org-wide)", scope: "Workspace & page" },
    Preview: WelcomePreview,
  },
  {
    type: "shortcuts",
    label: "Shortcuts",
    description: "Quick links to anywhere.",
    keywords: ["links", "quick links", "bookmarks", "navigation", "nav", "urls", "buttons"],
    icon: Link2,
    groups: { intent: "Page content", source: "Static content", scope: "Workspace & page" },
    Preview: ShortcutsPreview,
  },
  {
    type: "note",
    label: "Note",
    description: "Freeform rich text.",
    keywords: ["text", "rich text", "markdown", "document", "memo", "freeform", "notes"],
    icon: StickyNote,
    groups: { intent: "Page content", source: "Static content", scope: "Workspace & page" },
    Preview: NotePreview,
  },
  {
    type: "kanban",
    label: "Kanban",
    description: "A board grouped by an enum field.",
    keywords: ["board", "columns", "swimlanes", "status", "pipeline", "cards", "drag"],
    icon: SquareKanban,
    groups: { intent: "Collections", source: "Concept data", scope: "Concept-scoped" },
    Preview: KanbanPreview,
  },
  {
    type: "calendar",
    label: "Calendar",
    description: "Items placed on a month or week.",
    keywords: ["month", "week", "dates", "schedule", "agenda", "events", "date"],
    icon: CalendarDays,
    groups: { intent: "Collections", source: "Concept data", scope: "Concept-scoped" },
    Preview: CalendarPreview,
  },
  {
    type: "gantt",
    label: "Timeline / Gantt",
    description: "Item date ranges on a timeline.",
    keywords: [
      "timeline",
      "roadmap",
      "schedule",
      "bars",
      "date range",
      "milestones",
      "project",
      "ranges",
    ],
    icon: GanttChart,
    groups: { intent: "Collections", source: "Concept data", scope: "Concept-scoped" },
    Preview: GanttPreview,
  },
  {
    type: "files",
    label: "Files",
    description: "Attachments across items.",
    keywords: ["attachments", "documents", "uploads", "media", "downloads", "assets", "docs"],
    icon: Files,
    groups: { intent: "Collections", source: "Concept data", scope: "Concept-scoped" },
    Preview: FilesPreview,
  },
]
