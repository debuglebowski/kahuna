import { MemberDirectory } from "@/components/members/MemberDirectory"

/** The org directory page (`/members`) — heading + the shared directory. */
export function MembersDirectory() {
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold tracking-tight text-foreground">Members</h2>
      <MemberDirectory />
    </div>
  )
}
