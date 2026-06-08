import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Pencil, Plus, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useOutletContext } from "react-router-dom"
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Drawer,
  IconButton,
  Input,
  Modal,
  Spinner,
} from "../../components/ui"
import { api, type Field } from "../../lib/api"
import { ConceptGraphCanvas } from "./ConceptGraphCanvas"
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
      return `→ ${f.config.target ? nameOf(f.config.target) : "?"} (${f.config.cardinality ?? "many"})`
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
  const { admin } = useOutletContext<{ admin: boolean }>()
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

  // Seed the editor whenever the selected concept changes.
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
  // Concept names + relation fields drive the graph, so refresh it after every edit.
  const refetchGraph = () => qc.invalidateQueries({ queryKey: ["conceptGraph"] })

  const createConcept = useMutation({
    mutationFn: (name: string) => api.createConcept(name),
    onSuccess: (c) => {
      setCreatingConcept(false)
      setNewName("")
      qc.invalidateQueries({ queryKey: ["concepts"] })
      refetchGraph()
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["concepts"] })
      refetchGraph()
    },
  })
  const delConcept = useMutation({
    mutationFn: () => api.deleteConcept(selectedId!),
    onSuccess: () => {
      setSelectedId(null)
      qc.invalidateQueries({ queryKey: ["concepts"] })
      refetchGraph()
    },
  })
  const addField = useMutation({
    mutationFn: (v: FieldFormValue) =>
      api.addField({ conceptId: selectedId!, name: v.name, kind: v.kind, config: v.config }),
    onSuccess: () => {
      setAdding(false)
      refetchFields()
      refetchGraph()
    },
  })
  const updateField = useMutation({
    mutationFn: (vars: { id: string; name: string; config: FieldFormValue["config"] }) =>
      api.updateField({ id: vars.id, name: vars.name, config: vars.config }),
    onSuccess: () => {
      setEditingFieldId(null)
      refetchFields()
      refetchGraph()
    },
  })
  const delField = useMutation({
    mutationFn: (id: string) => api.deleteField(id),
    onSuccess: () => {
      refetchFields()
      refetchGraph()
    },
  })

  if (concepts.isPending) return <Spinner />

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Click a concept to view{admin ? " or edit" : ""} its settings.
        </p>
        {admin && (
          <Button onClick={() => setCreatingConcept(true)}>
            <Plus size={15} />
            New concept
          </Button>
        )}
      </div>

      <ConceptGraphCanvas selectedId={selectedId} onSelect={setSelectedId} />

      {creatingConcept && (
        <Modal title="New concept" onClose={() => setCreatingConcept(false)}>
          <div className="space-y-3">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewConcept()
              }}
              placeholder="Concept name…"
            />
            <div className="flex gap-2">
              <Button
                onClick={submitNewConcept}
                disabled={createConcept.isPending || !newName.trim()}
              >
                <Plus size={15} />
                {createConcept.isPending ? "Creating…" : "Create"}
              </Button>
              <Button variant="ghost" onClick={() => setCreatingConcept(false)}>
                <X size={15} />
                Cancel
              </Button>
            </div>
            {createConcept.error && (
              <p className="text-xs text-red-600">{msgOf(createConcept.error)}</p>
            )}
          </div>
        </Modal>
      )}

      {selected && (
        <Drawer
          title={selected.name}
          onClose={() => setSelectedId(null)}
          headerAction={
            <Link
              to={`/concepts/${selected.id}`}
              className="text-xs text-gray-500 hover:text-gray-800"
            >
              View instances
            </Link>
          }
        >
          <div className="space-y-5">
            <Card>
              <CardHeader
                title="Concept"
                action={
                  admin && (
                    <Button
                      onClick={() => saveConcept.mutate()}
                      disabled={saveConcept.isPending || !name.trim()}
                    >
                      <Check size={15} />
                      {saveConcept.isPending ? "Saving…" : "Save"}
                    </Button>
                  )
                }
              />
              <div className="space-y-2 p-4">
                <span className="text-xs font-medium text-gray-500">Name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!admin} />
                <span className="text-xs font-medium text-gray-500">Description</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  disabled={!admin}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm outline-none focus:border-gray-500 disabled:bg-gray-50 disabled:text-gray-500"
                />
                {saveConcept.error && (
                  <p className="text-sm text-red-600">{msgOf(saveConcept.error)}</p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Fields"
                action={
                  admin &&
                  !adding && (
                    <Button variant="ghost" onClick={() => setAdding(true)}>
                      <Plus size={15} />
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
                          onSubmit={(v) =>
                            updateField.mutate({ id: f.id, name: v.name, config: v.config })
                          }
                          onCancel={() => setEditingFieldId(null)}
                          pending={updateField.isPending}
                        />
                      </li>
                    ) : (
                      <li key={f.id} className="flex items-center gap-3 py-2.5">
                        <span className="w-40 shrink-0 truncate text-sm font-medium text-gray-900">
                          {f.name}
                        </span>
                        <Badge>{f.kind}</Badge>
                        <span className="flex-1 truncate text-xs text-gray-500">
                          {summarize(f, conceptName)}
                        </span>
                        {admin && (
                          <>
                            <IconButton
                              aria-label={`Edit ${f.name}`}
                              onClick={() => setEditingFieldId(f.id)}
                            >
                              <Pencil size={15} />
                            </IconButton>
                            <IconButton
                              variant="danger"
                              aria-label={`Delete ${f.name}`}
                              disabled={delField.isPending}
                              onClick={() => {
                                if (confirm(`Delete field "${f.name}"?`)) delField.mutate(f.id)
                              }}
                            >
                              <Trash2 size={15} />
                            </IconButton>
                          </>
                        )}
                      </li>
                    ),
                  )}
                </ul>
                {(updateField.error || delField.error) && (
                  <p className="text-sm text-red-600">
                    {msgOf(updateField.error ?? delField.error)}
                  </p>
                )}
              </div>
            </Card>

            {admin && (
              <div className="border-t border-gray-100 pt-4">
                <button
                  type="button"
                  disabled={delConcept.isPending}
                  onClick={() => {
                    if (confirm(`Delete concept "${selected.name}"? Its fields are removed too.`))
                      delConcept.mutate()
                  }}
                  className="inline-flex items-center gap-1.5 text-xs text-gray-400 transition hover:text-red-600 disabled:opacity-50"
                >
                  <Trash2 size={14} />
                  {delConcept.isPending ? "Deleting…" : "Delete concept"}
                </button>
                {delConcept.error && (
                  <p className="mt-2 text-sm text-red-600">{msgOf(delConcept.error)}</p>
                )}
              </div>
            )}
          </div>
        </Drawer>
      )}
    </div>
  )
}
