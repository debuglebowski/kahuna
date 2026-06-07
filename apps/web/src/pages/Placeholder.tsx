import { Card, CardHeader } from "../components/ui"

export function Placeholder({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      <div className="p-10 text-sm text-gray-400">{title} — coming soon.</div>
    </Card>
  )
}
