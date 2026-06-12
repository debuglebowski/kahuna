import { TaskDirectory } from "@/components/tasks/TaskDirectory"
import type { DashboardWidget } from "@/lib/api"

type Tasks = Extract<DashboardWidget, { type: "tasks" }>

/** Config scope → the directory's toolbar sentinel values. */
const SCOPE: Record<NonNullable<Tasks["assignee"]>, string> = {
  all: "__all",
  me: "__me",
  none: "__none",
}

/** The org-global task directory in a tile (same buckets/rows as `/tasks`),
 *  with config-time filters (status / due / concept), grouping, row-meta
 *  toggles, and a chrome-less checklist variant. */
export function TasksWidget({ widget }: { widget: Tasks }) {
  // The directory seeds its toolbar state from props in useState initializers,
  // so a config change must remount it — key on the config values.
  const key = [
    widget.assignee ?? "all",
    widget.showToolbar ?? true,
    widget.showComposer ?? true,
    widget.showDone ?? false,
    widget.variant ?? "full",
    widget.groupBy ?? "schedule",
    widget.rowMeta ? widget.rowMeta.join(",") : "*",
    (widget.statusIds ?? []).join(","),
    widget.due ?? "any",
    widget.conceptId ?? "",
  ].join("|")
  return (
    // cancel-drag: clicks/edits inside the list must never start a tile drag.
    <div className="cancel-drag h-full min-h-0 overflow-auto">
      <TaskDirectory
        key={key}
        defaultAssignee={SCOPE[widget.assignee ?? "all"]}
        showToolbar={widget.showToolbar ?? true}
        showComposer={widget.showComposer ?? true}
        defaultShowDone={widget.showDone ?? false}
        variant={widget.variant ?? "full"}
        groupBy={widget.groupBy ?? "schedule"}
        rowMeta={widget.rowMeta}
        statusIds={widget.statusIds}
        due={widget.due ?? "any"}
        conceptId={widget.conceptId ?? null}
      />
    </div>
  )
}
