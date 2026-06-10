import { History, ListChecks, StickyNote } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card } from "../ui"
import { ActivityFeed } from "./ActivityFeed"
import type { OrgMember } from "./AssigneePicker"
import { NotesPanel } from "./NotesPanel"
import { TaskList } from "./TaskList"

/**
 * The cross-cutting item surface: Notes · Tasks · Activity, mounted below the
 * Details/Connected grid on a Concept Item. `subjectId` is the item lineage id
 * (`instance.itemId`) so annotations survive re-publishes on versioned concepts.
 */
export function ItemTabs({
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
  return (
    <Card className="lg:col-span-2">
      <Tabs defaultValue="notes" className="gap-0">
        <TabsList variant="line" className="h-auto border-b border-border px-3 pt-1.5">
          <TabsTrigger value="notes" className="flex-none px-3">
            <StickyNote size={15} /> Notes
          </TabsTrigger>
          <TabsTrigger value="tasks" className="flex-none px-3">
            <ListChecks size={15} /> Tasks
          </TabsTrigger>
          <TabsTrigger value="activity" className="flex-none px-3">
            <History size={15} /> Activity
          </TabsTrigger>
        </TabsList>
        <TabsContent value="notes">
          <NotesPanel
            subjectId={subjectId}
            myUserId={myUserId}
            isAdmin={isAdmin}
            members={members}
          />
        </TabsContent>
        <TabsContent value="tasks">
          <TaskList subjectId={subjectId} myUserId={myUserId} isAdmin={isAdmin} members={members} />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityFeed subjectId={subjectId} />
        </TabsContent>
      </Tabs>
    </Card>
  )
}
