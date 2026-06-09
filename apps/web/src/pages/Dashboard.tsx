import { LayoutDashboard } from "lucide-react"

export function Dashboard() {
  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center rounded-xl border border-dashed p-12 text-center">
      <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <LayoutDashboard size={20} />
      </div>
      <h2 className="mb-1 text-lg font-medium text-foreground">Nothing to show yet</h2>
      <p className="max-w-sm text-sm text-balance text-muted-foreground">
        Your overview will fill in as you and your team work. Create a concept and add a few
        instances to start tracking activity here.
      </p>
    </div>
  )
}
