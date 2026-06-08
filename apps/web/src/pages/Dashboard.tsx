import { useLiveQuery } from "@tanstack/react-db"
import { Card, CardHeader, Spinner } from "../components/ui"
import { changedCollection, KEY, useRegisterCollection } from "../lib/collections"

const Empty = () => <div className="text-xs text-gray-400">Nothing here.</div>

export function Dashboard() {
  useRegisterCollection(KEY.changed, changedCollection)
  const changed = useLiveQuery((q) =>
    q.from({ c: changedCollection }).orderBy(({ c }) => c.id, "desc"),
  )

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader title="What changed" />
        <div className="divide-y divide-gray-100 text-sm">
          {changed.isLoading ? (
            <Spinner />
          ) : (changed.data ?? []).length === 0 ? (
            <div className="p-4">
              <Empty />
            </div>
          ) : (
            changed.data?.map((e) => (
              <div key={e.id} className="flex items-center justify-between px-4 py-2">
                <span className="text-gray-700">
                  {e.eventType} <span className="text-gray-400">· {e.subjectKind}</span>
                </span>
                <span className="text-xs text-gray-400">
                  {new Date(e.occurredAt).toLocaleString()}
                </span>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  )
}
