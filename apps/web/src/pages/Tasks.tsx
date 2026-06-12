import { TaskDirectory } from "@/components/tasks/TaskDirectory"

/** The global Tasks page (`/tasks`) — heading + the shared task directory. */
export function Tasks() {
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold tracking-tight text-foreground">Tasks</h2>
      <TaskDirectory />
    </div>
  )
}
