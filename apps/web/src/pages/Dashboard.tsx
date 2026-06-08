import { LayoutDashboard } from "lucide-react"
import { Card } from "../components/ui"

export function Dashboard() {
  return (
    <Card className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-400">
        <LayoutDashboard size={22} />
      </div>
      <h2 className="mb-1 text-base font-semibold text-gray-900">Nothing to show yet</h2>
      <p className="max-w-sm text-sm text-gray-500">
        Your overview will fill in as you and your team work. Create a concept and add a few
        instances to start tracking activity here.
      </p>
    </Card>
  )
}
