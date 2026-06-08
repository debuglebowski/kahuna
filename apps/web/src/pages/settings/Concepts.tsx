import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Badge, Button, Card, CardHeader, Input, Spinner } from "../../components/ui"
import { api, type Field } from "../../lib/api"
import { cn } from "../../lib/utils"
import { FieldForm, type FieldFormValue } from "./FieldForm"

function msgOf(e: unknown): string {
  const err = e as { code?: string; message?: string }
  if (err?.code === "CONCEPT_IN_USE" || err?.message?.includes("ConceptInUse"))
    return "Can't delete: this concept still has instances."
  if (err?.message?.includes("ConceptNameConflict"))
    return "A concept with that name already exists."
  if (err?.code === "FORBIDDEN" || err?.message?.includes("Admin only")) return "Admins only."
  return err?.message ?? "Something went wrong."
}

/** Render a field's config summary; `nameOf` resolves a relation target id → name. */
function summarize(f: Field, nameOf: (id: string) => string): string {
  switch (f.kind) {
    case "enum":
      return (f.config.options ?? []).join(", ")
    case "relation":
      return `${f.config.relationType ?? "?"} → ${f.config.target ? nameOf(f.config.target) : "?"} (${f.config.cardinality ?? "many"})`
    case "computed":
      return f.config.computedKind ?? ""
    case "user":
      return f.config.multiple ? "members (multiple)" : "member"
    case "money":
      return "amount + currency"
    case "json":
      return "json"
    case "text":
    case "number":
      return [f.config.format && `format: ${f.config.format}`, f.config.multiple && "multiple"]
        .filter(Boolean)
        .join(" · ")
    default:
      return f.config.multiple ? "multiple" : ""
  }
}

export function Concepts() {
  const qc = useQueryClient()
  const concepts = useQuery({ queryKey: ["concepts"], queryFn: () => api.listConcepts() })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [adding, setAdding] = useState(false)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [creatingConcept, setCreatingConcept] = useState(false)
  const [newName, setNewName] = useState("")

  const selected = concepts.data?.find((c) => c.id === selectedId) ?? null

  // Default-select the first concept; seed the description editor on selection.
  useEffect(() => {
    if (!selectedId && concepts.data?.length) setSelectedId(concepts.data[0]!.id)
  }, [concepts.data, selectedId])
  useEffect(() => {
    setName(selected?.name ?? "")
    setDescription(selected?.description ?? "")
    setAdding(false)
    setEditingFieldId(null)
  }, [selected])

  // Resolve a relation target concept id → its display name for field summaries.
  const conceptName = (id: string) => concepts.data?.find((c) => c.id === id)?.name ?? id

  const fields = useQuery({
    queryKey: ["fields", selectedId],
    queryFn: () => api.listFields(selectedId!),
    enabled: !!selectedId,
  })

  const refetchFields = () => qc.invalidateQueries({ queryKey: ["fields", selectedId] })

  const createConcept = useMutation({
    mutationFn: (name: string) => api.createConcept(name),
    onSuccess: (c) => {
      setCreatingConcept(false)
      setNewName("")
      qc.invalidateQueries({ queryKey: ["concepts"] })
      setSelectedId(c.id)
    },
  })
  const submitNewConcept = () => {
    const trimmed = newName.trim()
    if (trimmed) createConcept.mutate(trimmed)
  }

  const saveConcept = useMutation({
    mutationFn: () =>
      api.updateConcept(selectedId!, {
        name: name.trim(),
        description: description.trim() || null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["concepts"] }),
  })
  const delConcept = useMutation({
    mutationFn: () => api.deleteConcept(selectedId!),
    onSuccess: () => {
      setSelectedId(null)
      qc.invalidateQueries({ queryKey: ["concepts"] })
    },
  })
  const addField = useMutation({
    mutationFn: (v: FieldFormValue) =>
      api.addField({ conceptId: selectedId!, name: v.name, kind: v.kind, config: v.config }),
    onSuccess: () => {
      setAdding(false)
      refetchFields()
    },
  })
  const updateField = useMutation({
    mutationFn: (vars: { id: string; config: FieldFormValue["config"] }) =>
      api.updateField({ id: vars.id, config: vars.config }),
    onSuccess: () => {
      setEditingFieldId(null)
      refetchFields()
    },
  })
  const delField = useMutation({
    mutationFn: (id: string) => api.deleteField(id),
    onSuccess: refetchFields,
  })

  if (concepts.isPending) return <Spinner />

  return (
    <div className="grid grid-cols-[200px_1fr] gap-5">
      <div className="space-y-2">
        <nav className="space-y-1">
          {concepts.data?.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={cn(
                "block w-full rounded-md px-3 py-1.5 text-left text-sm",
                c.id === selectedId ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100",
              )}
            >
              {c.name}
            </button>
          ))}
          {concepts.data?.length === 0 && !creatingConcept && (
            <p className="px-3 text-xs text-gray-400">No concepts yet.</p>
          )}
        </nav>

        {creatingConcept ? (
          <div className="space-y-2">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewConcept()
                if (e.key === "Escape") {
                  setCreatingConcept(false)
                  setNewName("")
                }
              }}
              placeholder="New concept name…"
            />
            <div className="flex gap-2">
              <Button
                onClick={submitNewConcept}
                disabled={createConcept.isPending || !newName.trim()}
              >
                {createConcept.isPending ? "Creating…" : "Create"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setCreatingConcept(false)
                  setNewName("")
                }}
              >
                Cancel
              </Button>
            </div>
            {createConcept.error && (
              <p className="text-xs text-red-600">{msgOf(createConcept.error)}</p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCreatingConcept(true)}
            className="block w-full rounded-md px-3 py-1.5 text-left text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            + New concept
          </button>
        )}
      </div>

      {selected && (
        <div className="space-y-5">
          <Card>
            <CardHeader
              title={selected.name}
              action={
                <div className="flex gap-2">
                  <Button
                    onClick={() => saveConcept.mutate()}
                    disabled={saveConcept.isPending || !name.trim()}
                  >
                    {saveConcept.isPending ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={delConcept.isPending}
                    onClick={() => {
                      if (confirm(`Delete concept "${selected.name}"? Its fields are removed too.`))
                        delConcept.mutate()
                    }}
                  >
                    Delete
                  </Button>
                </div>
              }
            />
            <div className="space-y-2 p-4">
              <span className="text-xs font-medium text-gray-500">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
              <span className="text-xs font-medium text-gray-500">Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm outline-none focus:border-gray-500"
              />
              {(saveConcept.error || delConcept.error) && (
                <p className="text-sm text-red-600">
                  {msgOf(saveConcept.error ?? delConcept.error)}
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Fields"
              action={
                !adding && (
                  <Button variant="ghost" onClick={() => setAdding(true)}>
                    Add field
                  </Button>
                )
              }
            />
            <div className="space-y-3 p-4">
              {adding && (
                <FieldForm
                  concepts={concepts.data ?? []}
                  onSubmit={(v) => addField.mutate(v)}
                  onCancel={() => setAdding(false)}
                  pending={addField.isPending}
                />
              )}
              {addField.error && <p className="text-sm text-red-600">{msgOf(addField.error)}</p>}

              {fields.isPending && <Spinner />}
              <ul className="divide-y divide-gray-100">
                {fields.data?.map((f) =>
                  editingFieldId === f.id ? (
                    <li key={f.id} className="py-3">
                      <FieldForm
                        concepts={concepts.data ?? []}
                        initial={f}
                        onSubmit={(v) => updateField.mutate({ id: f.id, config: v.config })}
                        onCancel={() => setEditingFieldId(null)}
                        pending={updateField.isPending}
                      />
                    </li>
                  ) : (
                    <li key={f.id} className="flex items-center gap-3 py-2.5">
                      <span className="w-40 shrink-0 text-sm font-medium text-gray-900">
                        {f.name}
                      </span>
                      <Badge>{f.kind}</Badge>
                      <span className="flex-1 truncate text-xs text-gray-500">
                        {summarize(f, conceptName)}
                      </span>
                      <Button variant="ghost" onClick={() => setEditingFieldId(f.id)}>
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        disabled={delField.isPending}
                        onClick={() => {
                          if (confirm(`Delete field "${f.name}"?`)) delField.mutate(f.id)
                        }}
                      >
                        Delete
                      </Button>
                    </li>
                  ),
                )}
              </ul>
              {(updateField.error || delField.error) && (
                <p className="text-sm text-red-600">{msgOf(updateField.error ?? delField.error)}</p>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
