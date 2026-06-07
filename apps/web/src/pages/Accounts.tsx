import { useLiveQuery } from "@tanstack/react-db"
import { useMutation } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { Link } from "react-router-dom"
import { Badge, Button, Card, CardHeader, Field, Input, Select, Spinner } from "../components/ui"
import { api } from "../lib/api"
import { accountsCollection, KEY, useRegisterCollection } from "../lib/collections"
import { showValue } from "../lib/utils"

const PHASES = ["prospect", "deal", "live", "renewal"]

export function Accounts() {
  useRegisterCollection(KEY.accounts, accountsCollection)
  const accounts = useLiveQuery((q) => q.from({ a: accountsCollection }))
  const [name, setName] = useState("")
  const [phase, setPhase] = useState("prospect")
  const [value, setValue] = useState("")

  const create = useMutation({
    mutationFn: () =>
      api.createInstance("Account", {
        name,
        lifecycle_phase: phase,
        ...(value ? { contract_value: Number(value) } : {}),
      }),
    onSuccess: () => {
      setName("")
      setValue("")
      void accountsCollection.utils.refetch()
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card className="md:col-span-2">
        <CardHeader title="Accounts" />
        <div className="divide-y divide-gray-100">
          {accounts.isLoading ? (
            <Spinner />
          ) : (accounts.data ?? []).length === 0 ? (
            <div className="p-4 text-sm text-gray-400">No accounts yet — create one.</div>
          ) : (
            accounts.data?.map((a) => (
              <Link
                key={a.id}
                to={`/accounts/${a.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-gray-50"
              >
                <span className="font-medium text-gray-800">{showValue(a.state.name)}</span>
                <span className="flex items-center gap-2 text-sm text-gray-500">
                  <Badge>{showValue(a.state.lifecycle_phase)}</Badge>
                  {a.state.contract_value ? (
                    <span>${Number(a.state.contract_value).toLocaleString()}</span>
                  ) : null}
                </span>
              </Link>
            ))
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="New account" />
        <form className="space-y-3 p-4" onSubmit={submit}>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Lifecycle phase">
            <Select value={phase} onChange={(e) => setPhase(e.target.value)}>
              {PHASES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contract value">
            <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" disabled={create.isPending}>
            {create.isPending ? "…" : "Create account"}
          </Button>
          {create.isError ? (
            <p className="text-sm text-red-600">{(create.error as Error).message}</p>
          ) : null}
        </form>
      </Card>
    </div>
  )
}
