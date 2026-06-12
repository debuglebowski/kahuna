import { MemberDirectory } from "@/components/members/MemberDirectory"
import type { DashboardWidget } from "@/lib/api"

type Members = Extract<DashboardWidget, { type: "members" }>

/** The org member directory in a tile (same rows/admin actions as `/members`). */
export function MembersWidget({ widget }: { widget: Members }) {
  return (
    // cancel-drag: clicks/menus inside the list must never start a tile drag.
    <div className="cancel-drag h-full min-h-0 overflow-auto">
      <MemberDirectory
        key={String(widget.showToolbar ?? true)}
        showToolbar={widget.showToolbar ?? true}
      />
    </div>
  )
}
