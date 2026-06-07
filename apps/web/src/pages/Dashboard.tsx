import { useLiveQuery } from "@tanstack/react-db"
import type { ReactNode } from "react"
import { Badge, Card, CardHeader, decayTone, Spinner } from "../components/ui"
import type { DecayValue, Instance } from "../lib/api"
import {
  changedCollection,
  demandCollection,
  KEY,
  owedCollection,
  useRegisterCollection,
} from "../lib/collections"
import { showValue } from "../lib/utils"

const decayOf = (d: Instance) => d.state.decay as DecayValue | undefined

const Section = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">{label}</div>
    <div className="space-y-1">{children}</div>
  </div>
)
const Row = ({ children }: { children: ReactNode }) => (
  <div className="flex items-center justify-between rounded bg-gray-50 px-2 py-1">{children}</div>
)
const Empty = () => <div className="text-xs text-gray-400">Nothing here.</div>

export function Dashboard() {
  useRegisterCollection(KEY.owed, owedCollection)
  useRegisterCollection(KEY.changed, changedCollection)
  useRegisterCollection(KEY.demand, demandCollection)
  const owedQ = useLiveQuery((q) => q.from({ o: owedCollection }))
  const changed = useLiveQuery((q) =>
    q.from({ c: changedCollection }).orderBy(({ c }) => c.id, "desc"),
  )
  const demand = useLiveQuery((q) =>
    q.from({ d: demandCollection }).orderBy(({ d }) => d.weight, "desc"),
  )
  const owed = { isLoading: owedQ.isLoading, data: owedQ.data?.[0] }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader title="What's owed" />
        <div className="space-y-3 p-4 text-sm">
          {owed.isLoading ? (
            <Spinner />
          ) : (
            <>
              <Section label="Decaying deals">
                {(owed.data?.decayingDeals ?? []).length === 0 ? (
                  <Empty />
                ) : (
                  owed.data?.decayingDeals.map((d) => (
                    <Row key={d.id}>
                      <span className="text-gray-700">Deal · {showValue(d.state.status)}</span>
                      <Badge tone={decayTone(decayOf(d)?.band)}>
                        {decayOf(d)?.band} · {decayOf(d)?.days}d
                      </Badge>
                    </Row>
                  ))
                )}
              </Section>
              <Section label="Due renewals">
                {(owed.data?.dueRenewals ?? []).length === 0 ? (
                  <Empty />
                ) : (
                  owed.data?.dueRenewals.map((d) => (
                    <Row key={d.id}>
                      <span className="text-gray-700">Deal · {showValue(d.state.status)}</span>
                      <Badge tone="amber">renewal</Badge>
                    </Row>
                  ))
                )}
              </Section>
              <Section label="Open tasks">
                {(owed.data?.openTasks ?? []).length === 0 ? (
                  <Empty />
                ) : (
                  owed.data?.openTasks.map((t) => (
                    <Row key={t.id}>
                      <span className="text-gray-700">{showValue(t.state.title)}</span>
                      {t.state.due_date ? (
                        <Badge>{showValue(t.state.due_date).slice(0, 10)}</Badge>
                      ) : null}
                    </Row>
                  ))
                )}
              </Section>
            </>
          )}
        </div>
      </Card>

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

      <Card>
        <CardHeader title="Demand · by account value" />
        <div className="divide-y divide-gray-100 text-sm">
          {demand.isLoading ? (
            <Spinner />
          ) : (demand.data ?? []).length === 0 ? (
            <div className="p-4">
              <Empty />
            </div>
          ) : (
            demand.data?.map((d) => (
              <div key={d.signal.id} className="flex items-center justify-between px-4 py-2">
                <span>
                  <Badge tone="blue">{showValue(d.signal.state.kind)}</Badge>
                  <span className="ml-1 text-gray-700">
                    {showValue(d.signal.state.description)}
                  </span>
                  <div className="text-xs text-gray-400">{d.accountName ?? "—"}</div>
                </span>
                <span className="font-medium text-gray-700">${d.weight.toLocaleString()}</span>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  )
}
