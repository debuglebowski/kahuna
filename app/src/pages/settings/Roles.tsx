import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Lock, Plus, Trash2, X } from "lucide-react"
import { useState } from "react"
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  IconButton,
  Input,
  Modal,
  Spinner,
  Toolbar,
} from "../../components/ui"
import { type AccessActionName, type AccessResourceType, type AccessRole, api } from "../../lib/api"
import { Feedback } from "./parts"

/**
 * Role management — the editor for the access model's reusable half.
 *
 * A role is a named bag of rules; a per-person share is the same thing attached to
 * one actor (that lives in the Share dialog, not here). Presets are ordinary rows and
 * fully editable; only their DELETION is refused, because the seed pins them by key
 * and would silently re-create one.
 *
 * `configure`-gated as a whole: the rules inside a role are the sensitive part. Role
 * NAMES are readable by any member and render as pills on /members.
 */

const ACTIONS: ReadonlyArray<AccessActionName> = [
  "view",
  "create",
  "edit",
  "archive",
  "delete",
  "share",
  "configure",
]

const RESOURCES: ReadonlyArray<AccessResourceType> = [
  "org",
  "concept",
  "record",
  "field",
  "dashboard",
  "view",
  "automation",
  "bucket",
  "task",
  "note",
  "member",
]

/** Engine errors reach the client as a code + prose; surface the prose when it is
 *  meant for a human (the floor guard's messages are). */
function roleMsg(e: unknown): string {
  const err = e as { code?: string; message?: string }
  if (err?.code === "FORBIDDEN") return "Admins only."
  return err?.message ?? "Something went wrong."
}

function RuleEditor({ role, onClose }: { role: AccessRole; onClose: () => void }) {
  const qc = useQueryClient()
  const rules = useQuery({ queryKey: ["rules", role.id], queryFn: () => api.listRules(role.id) })
  const [effect, setEffect] = useState<"allow" | "deny">("allow")
  const [resourceType, setResourceType] = useState<AccessResourceType>("concept")
  const [actions, setActions] = useState<ReadonlyArray<AccessActionName>>(["view"])

  const add = useMutation({
    mutationFn: () => api.addRule({ roleId: role.id, effect, actions, resourceType }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["rules", role.id] })
      setActions(["view"])
    },
  })
  const remove = useMutation({
    mutationFn: (ruleId: string) => api.removeRule(ruleId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["rules", role.id] }),
  })

  const toggle = (a: AccessActionName) =>
    setActions((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]))

  return (
    <Modal onClose={onClose} title={`Rules — ${role.name}`} size="wide">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Rules are exceptions layered over each resource's own default. A <b>deny</b> always wins,
          whatever else grants access.
        </p>

        {rules.isPending ? (
          <Spinner />
        ) : rules.data && rules.data.length > 0 ? (
          <div className="divide-y rounded-md border">
            {rules.data.map((r) => (
              <div key={r.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <Badge tone={r.effect === "deny" ? "red" : "green"}>{r.effect}</Badge>
                <span className="font-medium">{r.actions.join(", ")}</span>
                <span className="text-muted-foreground">on</span>
                <span>{r.resourceType}</span>
                {r.resourceId ? (
                  <span className="text-muted-foreground">#{r.resourceId.slice(0, 8)}</span>
                ) : (
                  <span className="text-muted-foreground">(any)</span>
                )}
                {r.condition ? <Badge tone="blue">conditional</Badge> : null}
                <span className="ml-auto">
                  <IconButton
                    aria-label="Remove rule"
                    title="Remove rule"
                    onClick={() => remove.mutate(r.id)}
                    disabled={remove.isPending}
                  >
                    <X size={14} />
                  </IconButton>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No rules yet — this role grants nothing beyond what every member gets.
          </p>
        )}
        <Feedback error={remove.error ? roleMsg(remove.error) : undefined} />

        <div className="space-y-2 rounded-md border p-3">
          <span className="block text-sm font-medium">Add a rule</span>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={effect}
              onChange={(e) => setEffect(e.target.value as "allow" | "deny")}
            >
              <option value="allow">allow</option>
              <option value="deny">deny</option>
            </select>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={resourceType}
              onChange={(e) => setResourceType(e.target.value as AccessResourceType)}
            >
              {RESOURCES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ACTIONS.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => toggle(a)}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  actions.includes(a)
                    ? "border-primary bg-primary/10 text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {a}
              </button>
            ))}
          </div>
          <Button
            onClick={() => add.mutate()}
            disabled={add.isPending || actions.length === 0}
            size="sm"
          >
            Add rule
          </Button>
          <Feedback error={add.error ? roleMsg(add.error) : undefined} />
        </div>
      </div>
    </Modal>
  )
}

export function Roles() {
  const qc = useQueryClient()
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.listRoles() })
  const [filter, setFilter] = useState("")
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [editing, setEditing] = useState<AccessRole | null>(null)
  const [deleting, setDeleting] = useState<AccessRole | null>(null)

  const create = useMutation({
    mutationFn: () => api.createRole(name.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["roles"] })
      setCreating(false)
      setName("")
    },
  })
  const del = useMutation({
    mutationFn: (id: string) => api.deleteRole(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["roles"] })
      setDeleting(null)
    },
  })

  if (roles.isPending) return <Spinner />
  if (roles.error) return <Feedback error={roleMsg(roles.error)} />

  const q = filter.trim().toLowerCase()
  const shown = (roles.data ?? []).filter((r) => !q || r.name.toLowerCase().includes(q))

  return (
    <div className="space-y-4">
      {/* Functional toolbar: filter left, create right, no description row — the
          settings convention for every tab that can create something. */}
      <Toolbar filter={filter} onFilter={setFilter} placeholder="Filter roles…">
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus size={15} />
          New role
        </Button>
      </Toolbar>

      <Card>
        <div className="divide-y">
          {shown.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              No roles match. A role is a reusable set of rules; assign them to members on the
              Members page.
            </p>
          ) : null}
          {shown.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  {r.builtin ? (
                    <Badge tone="gray">
                      <Lock size={11} /> preset
                    </Badge>
                  ) : null}
                </div>
                {r.description ? (
                  <p className="truncate text-sm text-muted-foreground">{r.description}</p>
                ) : null}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setEditing(r)}>
                  Rules
                </Button>
                {/* A preset's rules stay editable — only deletion is refused, because
                    the seed pins presets by key and would re-create one. */}
                {r.builtin ? null : (
                  <IconButton
                    aria-label={`Delete ${r.name}`}
                    title="Delete role"
                    variant="danger"
                    onClick={() => setDeleting(r)}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {creating ? (
        <Modal onClose={() => setCreating(false)} title="New role">
          <div className="space-y-3">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sales"
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) create.mutate()
              }}
            />
            <Feedback error={create.error ? roleMsg(create.error) : undefined} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
                Create
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {editing ? <RuleEditor role={editing} onClose={() => setEditing(null)} /> : null}

      {deleting ? (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          // Immediate, not deferred: everyone holding it loses that access at once.
          message="Everyone holding this role loses its access immediately. The history stays on the activity log."
          confirmLabel="Delete role"
          confirmVariant="danger"
          pending={del.isPending}
          error={del.error ? roleMsg(del.error) : undefined}
          onConfirm={() => del.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </div>
  )
}
