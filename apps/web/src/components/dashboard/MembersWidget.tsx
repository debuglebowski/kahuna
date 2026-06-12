import { MemberDirectory } from "@/components/members/MemberDirectory"
import type { DashboardWidget } from "@/lib/api"

type Members = Extract<DashboardWidget, { type: "members" }>

/** The org member directory in a tile (same rows/admin actions as `/members`),
 *  or a read-only avatar grid for orientation; field/sort/limit shape it for
 *  small tiles. */
export function MembersWidget({ widget }: { widget: Members }) {
  const key = [
    widget.showToolbar ?? true,
    widget.variant ?? "rows",
    widget.fields ? widget.fields.join(",") : "*",
    widget.sort ?? "name",
    widget.limit ?? "",
  ].join("|")
  return (
    // cancel-drag: clicks/menus inside the list must never start a tile drag.
    <div className="cancel-drag h-full min-h-0 overflow-auto">
      <MemberDirectory
        key={key}
        showToolbar={widget.showToolbar ?? true}
        variant={widget.variant ?? "rows"}
        fields={widget.fields ?? ["role", "email"]}
        sort={widget.sort ?? "name"}
        limit={widget.limit ?? null}
      />
    </div>
  )
}
