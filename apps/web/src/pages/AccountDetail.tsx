import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import { InlineForm } from "../components/InlineForm"
import { Badge, Button, Card, CardHeader, decayTone, momentumTone, Spinner } from "../components/ui"
import {
  type AccountHub,
  apiGet,
  apiPost,
  type DecayValue,
  type Instance,
  type MomentumValue,
} from "../lib/api"
import { showValue } from "../lib/utils"

const STATUS_NEXT: Record<string, string[]> = {
  lead: ["qualified", "lost"],
  qualified: ["proposal", "lost"],
  proposal: ["negotiation", "lost"],
  negotiation: ["won", "lost"],
  won: [],
  lost: [],
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <Card>
    <CardHeader title={title} />
    <div className="space-y-3 p-4">{children}</div>
  </Card>
)

export function AccountDetail() {
  const { id = "" } = useParams()
  const qc = useQueryClient()
  const hub = useQuery({
    queryKey: ["account", id],
    queryFn: () => apiGet<AccountHub>(`/api/accounts/${id}`),
    enabled: !!id,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["account", id] })
    for (const k of ["owed", "changed", "demand", "accounts"]) {
      qc.invalidateQueries({ queryKey: [k] })
    }
  }

  const capture = (sub: string) => (fields: Record<string, unknown>) =>
    apiPost(`/api/accounts/${id}/${sub}`, { fields })

  const addContact = useMutation({ mutationFn: capture("contacts"), onSuccess: invalidate })
  const logInteraction = useMutation({ mutationFn: capture("interactions"), onSuccess: invalidate })
  const raiseSignal = useMutation({ mutationFn: capture("signals"), onSuccess: invalidate })
  const addTask = useMutation({ mutationFn: capture("tasks"), onSuccess: invalidate })
  const addDeal = useMutation({
    mutationFn: (f: Record<string, string>) =>
      apiPost(`/api/accounts/${id}/deals`, {
        fields: { status: f.status, is_renewal: f.is_renewal === "yes" },
      }),
    onSuccess: invalidate,
  })
  const advanceDeal = useMutation({
    mutationFn: (p: { dealId: string; version: number; to: string }) =>
      apiPost(`/api/instances/${p.dealId}/transition`, {
        expectedVersion: p.version,
        field: "status",
        to: p.to,
      }),
    onSuccess: invalidate,
  })
  const completeTask = useMutation({
    mutationFn: (p: { taskId: string; version: number }) =>
      apiPost(`/api/instances/${p.taskId}`, { expectedVersion: p.version, patch: { done: true } }),
    onSuccess: invalidate,
  })
  const addArtifact = useMutation({
    mutationFn: (fields: Record<string, unknown>) =>
      apiPost(`/api/accounts/${id}/artifacts`, { fields }),
    onSuccess: invalidate,
  })
  const uploadFile = useMutation({
    mutationFn: async (p: { artifactId: string; file: File }) => {
      const fd = new FormData()
      fd.append("file", p.file)
      const res = await fetch(`/api/instances/${p.artifactId}/attachments`, {
        method: "POST",
        body: fd,
      })
      if (!res.ok) throw new Error("upload failed")
      return res.json()
    },
    onSuccess: invalidate,
  })

  if (hub.isLoading) return <Spinner />
  if (hub.isError || !hub.data)
    return <div className="text-sm text-red-600">Account not found.</div>
  const { account, contacts, interactions, signals, tasks, deals, artifacts } = hub.data
  const s = account.state

  return (
    <div className="space-y-4">
      <Link to="/accounts" className="text-sm text-gray-500 hover:underline">
        ← Accounts
      </Link>

      <Card>
        <div className="flex items-start justify-between p-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">{showValue(s.name)}</h1>
            <div className="mt-1 flex items-center gap-2 text-sm text-gray-500">
              <Badge>{showValue(s.lifecycle_phase)}</Badge>
              {s.contract_value ? (
                <span>${Number(s.contract_value).toLocaleString()} contract</span>
              ) : null}
              {s.prospecting_value ? (
                <span>${Number(s.prospecting_value).toLocaleString()} prospecting</span>
              ) : null}
            </div>
          </div>
        </div>
        {s.intel ? (
          <p className="border-t border-gray-100 px-4 py-3 text-sm text-gray-600">
            {showValue(s.intel)}
          </p>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Deals · health">
          {deals.length === 0 ? (
            <Empty />
          ) : (
            deals.map((d) => (
              <DealRow
                key={d.id}
                deal={d}
                onAdvance={(to) => advanceDeal.mutate({ dealId: d.id, version: d.version, to })}
              />
            ))
          )}
          {advanceDeal.isError ? (
            <p className="text-sm text-red-600">{(advanceDeal.error as Error).message}</p>
          ) : null}
          <div className="border-t border-gray-100 pt-3">
            <InlineForm
              fields={[
                {
                  name: "status",
                  label: "Status",
                  options: ["lead", "qualified", "proposal", "negotiation"],
                },
                { name: "is_renewal", label: "Renewal?", options: ["no", "yes"] },
              ]}
              submitLabel="Add deal"
              pending={addDeal.isPending}
              onSubmit={(v) => addDeal.mutate(v)}
            />
          </div>
        </Section>

        <Section title="People">
          {contacts.length === 0 ? (
            <Empty />
          ) : (
            contacts.map((c) => (
              <Row key={c.id}>
                <span className="text-gray-700">{showValue(c.state.name)}</span>
                <span className="flex items-center gap-2 text-sm text-gray-500">
                  <Badge tone="blue">{showValue(c.state.role)}</Badge>
                  {showValue(c.state.email)}
                </span>
              </Row>
            ))
          )}
          <div className="border-t border-gray-100 pt-3">
            <InlineForm
              fields={[
                { name: "name", label: "Name" },
                { name: "email", label: "Email" },
                {
                  name: "role",
                  label: "Role",
                  options: ["champion", "economic_buyer", "blocker", "user"],
                },
              ]}
              submitLabel="Add contact"
              pending={addContact.isPending}
              onSubmit={(v) => addContact.mutate(v)}
            />
          </div>
        </Section>

        <Section title="Interaction timeline">
          {interactions.length === 0 ? (
            <Empty />
          ) : (
            interactions.map((i) => (
              <Row key={i.id}>
                <span className="text-gray-700">
                  <Badge>{showValue(i.state.kind)}</Badge>{" "}
                  <span className="ml-1">{showValue(i.state.note)}</span>
                </span>
                <span className="text-xs text-gray-400">
                  {showValue(i.state.occurred_on).slice(0, 10)}
                </span>
              </Row>
            ))
          )}
          <div className="border-t border-gray-100 pt-3">
            <InlineForm
              fields={[
                { name: "occurred_on", label: "Date", type: "date" },
                { name: "kind", label: "Kind", options: ["call", "email", "meeting", "note"] },
                { name: "note", label: "Note" },
              ]}
              submitLabel="Log"
              pending={logInteraction.isPending}
              onSubmit={(v) => logInteraction.mutate(v)}
            />
          </div>
        </Section>

        <Section title="Signals">
          {signals.length === 0 ? (
            <Empty />
          ) : (
            signals.map((sig) => (
              <Row key={sig.id}>
                <span className="text-gray-700">
                  <Badge tone="blue">{showValue(sig.state.kind)}</Badge>{" "}
                  <span className="ml-1">{showValue(sig.state.description)}</span>
                </span>
                <Badge>{showValue(sig.state.status)}</Badge>
              </Row>
            ))
          )}
          <div className="border-t border-gray-100 pt-3">
            <InlineForm
              fields={[
                { name: "kind", label: "Kind", options: ["request", "risk", "renewal"] },
                { name: "description", label: "Description" },
                { name: "status", label: "Status", options: ["captured", "promoted", "shipped"] },
              ]}
              submitLabel="Raise"
              pending={raiseSignal.isPending}
              onSubmit={(v) => raiseSignal.mutate(v)}
            />
          </div>
        </Section>

        <Section title="Tasks">
          {tasks.length === 0 ? (
            <Empty />
          ) : (
            tasks.map((t) => (
              <Row key={t.id}>
                <span className={t.state.done ? "text-gray-400 line-through" : "text-gray-700"}>
                  {showValue(t.state.title)}
                </span>
                <span className="flex items-center gap-2">
                  {t.state.due_date ? (
                    <Badge>{showValue(t.state.due_date).slice(0, 10)}</Badge>
                  ) : null}
                  {!t.state.done ? (
                    <Button
                      variant="ghost"
                      onClick={() => completeTask.mutate({ taskId: t.id, version: t.version })}
                    >
                      Done
                    </Button>
                  ) : null}
                </span>
              </Row>
            ))
          )}
          <div className="border-t border-gray-100 pt-3">
            <InlineForm
              fields={[
                { name: "title", label: "Title" },
                { name: "due_date", label: "Due", type: "date" },
              ]}
              submitLabel="Add task"
              pending={addTask.isPending}
              onSubmit={(v) => addTask.mutate(v)}
            />
          </div>
        </Section>

        <Section title="Artifacts">
          {artifacts.length === 0 ? (
            <Empty />
          ) : (
            artifacts.map((a) => (
              <div key={a.id} className="rounded border border-gray-100 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-700">{showValue(a.state.doc_type)}</span>
                  <Badge>{showValue(a.state.status)}</Badge>
                </div>
                <div className="mt-2 space-y-1">
                  {a.attachments.length === 0 ? (
                    <p className="text-xs text-gray-400">No files.</p>
                  ) : (
                    a.attachments.map((att) => (
                      <a
                        key={att.id}
                        href={`/api/attachments/${att.id}/download`}
                        className="block text-sm text-blue-600 hover:underline"
                      >
                        ⬇ {att.filename}
                        {att.sizeBytes != null ? (
                          <span className="text-xs text-gray-400"> · {att.sizeBytes} B</span>
                        ) : null}
                      </a>
                    ))
                  )}
                </div>
                <input
                  type="file"
                  className="mt-2 text-xs"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) uploadFile.mutate({ artifactId: a.id, file })
                    e.target.value = ""
                  }}
                />
              </div>
            ))
          )}
          <div className="border-t border-gray-100 pt-3">
            <InlineForm
              fields={[
                {
                  name: "doc_type",
                  label: "Type",
                  options: ["contract", "dpa", "sow", "questionnaire"],
                },
                { name: "status", label: "Status", options: ["draft", "active", "expired"] },
              ]}
              submitLabel="Add artifact"
              pending={addArtifact.isPending}
              onSubmit={(v) => addArtifact.mutate(v)}
            />
          </div>
        </Section>
      </div>
    </div>
  )
}

const Row = ({ children }: { children: ReactNode }) => (
  <div className="flex items-center justify-between rounded bg-gray-50 px-3 py-2 text-sm">
    {children}
  </div>
)
const Empty = () => <div className="text-xs text-gray-400">Nothing here yet.</div>

function DealRow({ deal, onAdvance }: { deal: Instance; onAdvance: (to: string) => void }) {
  const status = String(deal.state.status ?? "")
  const decay = deal.state.decay as DecayValue | undefined
  const momentum = deal.state.momentum as MomentumValue | undefined
  const next = STATUS_NEXT[status] ?? []
  return (
    <div className="rounded border border-gray-100 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge>{status}</Badge>
          {decay ? (
            <Badge tone={decayTone(decay.band)}>
              decay {decay.band}
              {decay.days != null ? ` · ${decay.days}d` : ""}
            </Badge>
          ) : null}
          {momentum ? (
            <Badge tone={momentumTone(momentum.label)}>momentum {momentum.label}</Badge>
          ) : null}
          {deal.state.is_renewal ? <Badge tone="amber">renewal</Badge> : null}
        </div>
        {next.length > 0 ? (
          <select
            className="rounded-md border border-gray-300 px-2 py-1 text-sm"
            value=""
            onChange={(e) => e.target.value && onAdvance(e.target.value)}
          >
            <option value="">advance…</option>
            {next.map((to) => (
              <option key={to} value={to}>
                {to}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {deal.state.blocker ? (
        <p className="mt-2 text-sm text-gray-500">Blocker: {showValue(deal.state.blocker)}</p>
      ) : null}
      {deal.state.next_touchpoint ? (
        <p className="text-xs text-gray-400">
          Next touchpoint: {showValue(deal.state.next_touchpoint).slice(0, 10)}
        </p>
      ) : null}
    </div>
  )
}
