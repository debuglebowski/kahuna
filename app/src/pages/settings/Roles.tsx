import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Lock, Plus, Trash2, X } from "lucide-react"
import { useState } from "react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  Modal,
  Spinner,
  ToggleChip,
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

/**
 * Actions in the order they escalate — view, then the write verbs, then the two that
 * are admin-only by default. Not alphabetical: the list is read as "how much power is
 * this?", so `delete` and `configure` sitting last is information.
 */
const ACTIONS: ReadonlyArray<{ id: AccessActionName; label: string; hint: string }> = [
  { id: "view", label: "View", hint: "Read it" },
  { id: "create", label: "Create", hint: "Add new ones" },
  { id: "edit", label: "Edit", hint: "Change existing ones" },
  { id: "archive", label: "Archive", hint: "Hide, restorably" },
  { id: "delete", label: "Delete", hint: "Destroy permanently" },
  { id: "share", label: "Share", hint: "Grant access to others" },
  { id: "configure", label: "Configure", hint: "Change its setup" },
]

/**
 * Resources grouped the way someone thinks about them, with plain-English names —
 * the wire values (`record`, `bucket`, `view`) are engine vocabulary and mean little
 * on their own.
 */
const RESOURCE_GROUPS: ReadonlyArray<{
  label: string
  items: ReadonlyArray<{ id: AccessResourceType; label: string; hint: string }>
}> = [
  {
    label: "Data",
    items: [
      { id: "concept", label: "Concepts", hint: "The types themselves — Deal, Company" },
      { id: "record", label: "Records", hint: "Individual entries" },
      { id: "field", label: "Fields", hint: "Values on a record" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "dashboard", label: "Dashboards", hint: "Widget canvases" },
      { id: "view", label: "Sidebar views", hint: "Nav layouts" },
      { id: "bucket", label: "File buckets", hint: "Files on a widget" },
    ],
  },
  {
    label: "Collaboration",
    items: [
      { id: "task", label: "Tasks", hint: "" },
      { id: "note", label: "Notes", hint: "" },
      { id: "member", label: "Members", hint: "People in the org" },
    ],
  },
  {
    label: "Administration",
    items: [
      { id: "automation", label: "Automations", hint: "" },
      { id: "org", label: "Organisation", hint: "Org-wide settings" },
    ],
  },
]

const RESOURCE_LABEL = new Map<string, string>(
  RESOURCE_GROUPS.flatMap((g) => g.items).map((r) => [r.id, r.label] as const),
)

/** Which group a resource belongs to — the SAME grouping the picker offers, so the list
 *  someone reads and the menu they choose from agree. */
const GROUP_OF = new Map<string, string>(
  RESOURCE_GROUPS.flatMap((g) => g.items.map((r) => [r.id, g.label] as const)),
)

/** Sort position within a group, mirroring the picker's order (Concepts before Records
 *  before Fields, not alphabetical) so a rule sits where the reader expects it. */
const RESOURCE_RANK = new Map<string, number>(
  RESOURCE_GROUPS.flatMap((g) => g.items).map((r, i) => [r.id, i] as const),
)

/**
 * What a rule's Scope column reads.
 *
 * `conceptName` resolves the id a targeted rule carries — showing `a1b2c3d4…` told the
 * reader a rule was narrowed but not to what, which is the one thing they need.
 */
const scopeLabelFor = (
  rule: {
    readonly resourceId: string | null
    readonly conceptId: string | null
    readonly condition: unknown
  },
  conceptName: (id: string) => string | undefined,
): string => {
  const target = rule.resourceId ?? rule.conceptId
  if (target) {
    const named = conceptName(target)
    // A record rule scoped by concept covers the records IN it, not the concept.
    const suffix = rule.conceptId && !rule.resourceId ? " (records)" : ""
    return named ? `${named}${suffix}` : `${target.slice(0, 8)}…`
  }
  if (rule.condition) return "Matching records"
  return "All"
}

/**
 * Bucket a role's rules by resource group, dropping empty groups.
 *
 * A flat list of eleven rows made the reader scan for the row they wanted; a role's
 * rules are almost always "everything, everywhere", so the shape of what it grants is
 * the actual information. Groups carry a count for that reason.
 *
 * An unrecognised `resourceType` (a newer server than this client) falls into "Other"
 * rather than vanishing — a rule the UI can't name is exactly the one worth showing.
 */
const groupRules = <T extends { readonly resourceType: string }>(
  rules: ReadonlyArray<T>,
): ReadonlyArray<{ readonly label: string; readonly rules: ReadonlyArray<T> }> => {
  const order = [...RESOURCE_GROUPS.map((g) => g.label), "Other"]
  const byGroup = new Map<string, T[]>()
  for (const r of rules) {
    const group = GROUP_OF.get(r.resourceType) ?? "Other"
    const list = byGroup.get(group)
    if (list) list.push(r)
    else byGroup.set(group, [r])
  }
  return order
    .filter((label) => byGroup.has(label))
    .map((label) => ({
      label,
      rules: [...(byGroup.get(label) ?? [])].sort(
        (a, b) =>
          (RESOURCE_RANK.get(a.resourceType) ?? 99) - (RESOURCE_RANK.get(b.resourceType) ?? 99),
      ),
    }))
}
const ACTION_LABEL = new Map<string, string>(ACTIONS.map((a) => [a.id, a.label] as const))

/**
 * How a rule's actions read in the table.
 *
 * `["*"]` is the wildcard the presets carry; showing a literal asterisk in a column
 * headed "Can" told the reader nothing. Named actions are Title Cased and joined.
 */
const actionsLabel = (actions: ReadonlyArray<string>): string => {
  if (actions.includes("*")) return "Everything"
  if (actions.length === 0) return "Nothing"
  return actions.map((a) => ACTION_LABEL.get(a as AccessActionName) ?? a).join(", ")
}

/** Engine errors reach the client as a code + prose; surface the prose when it is
 *  meant for a human (the floor guard's messages are). */
function roleMsg(e: unknown): string {
  const err = e as { code?: string; message?: string }
  const raw = err?.message ?? ""
  if (err?.code === "FORBIDDEN" || raw.includes("Admin only")) return "Admins only."
  // The engine's user-facing prose arrives inside a rendered Effect cause, so it is
  // matched rather than read off a field (same approach as `labelMsg` in Labels.tsx).
  // These two are the FLOOR guard, and its whole value is the reader learning WHY —
  // "Something went wrong" made a working safety rail look like a bug.
  if (raw.includes("only thing granting org configuration"))
    return "This is the only rule granting org configuration — add another before removing it."
  if (raw.includes("only member who can configure"))
    return "This is the only member who can configure the org — assign someone else first."
  if (raw.includes("preset role can't be deleted"))
    return "Preset roles can't be deleted. Edit their rules instead."
  if (raw.includes("role not found")) return "That role no longer exists."
  // Anything else: pass the server's own text through when it looks like prose (the
  // engine's messages are written for humans), else a neutral fallback.
  return raw && !raw.trimStart().startsWith("{") ? raw : "Something went wrong."
}

function RuleEditor({ role, onClose }: { role: AccessRole; onClose: () => void }) {
  const qc = useQueryClient()
  const rules = useQuery({ queryKey: ["rules", role.id], queryFn: () => api.listRules(role.id) })
  const [effect, setEffect] = useState<"allow" | "deny">("allow")
  const [resourceType, setResourceType] = useState<AccessResourceType>("concept")
  const [actions, setActions] = useState<ReadonlyArray<AccessActionName>>(["view"])
  // "" = every one of that type. Only concept-shaped rules can name a target here;
  // a record is picked from the record's own Share dialog, not from a role.
  const [targetId, setTargetId] = useState("")
  // The form is a deliberate step, not the resting state: a role's rules are read far
  // more often than they are written, and an always-open form made the screen look
  // like a data-entry page rather than a list of what this role grants.
  const [adding, setAdding] = useState(false)
  /** null while adding; the rule's id while editing one. Drives the form's copy and
   *  which mutation the submit runs. */
  const [editingId, setEditingId] = useState<string | null>(null)

  const resetDraft = () => {
    setEffect("allow")
    setResourceType("concept")
    setTargetId("")
    setActions(["view"])
    setEditingId(null)
  }

  /** Open the form on an existing rule, prefilled. `*` has no chip, so a wildcard rule
   *  loads with every action selected — the closest faithful representation, and
   *  saving it writes those actions explicitly rather than silently keeping `*`. */
  const startEditing = (r: {
    id: string
    effect: "allow" | "deny"
    actions: ReadonlyArray<string>
    resourceType: string
    resourceId: string | null
    conceptId: string | null
  }) => {
    setEditingId(r.id)
    setEffect(r.effect)
    setResourceType(r.resourceType as AccessResourceType)
    setTargetId(r.resourceId ?? r.conceptId ?? "")
    setActions(
      r.actions.includes("*")
        ? ACTIONS.map((a) => a.id)
        : (r.actions.filter((a) => ACTION_LABEL.has(a)) as ReadonlyArray<AccessActionName>),
    )
    setAdding(true)
  }

  // Named targets for the picker AND for resolving ids in the table's Scope column.
  // Not gated on the selected type: the table needs names for rules that are already
  // there, whatever the form happens to be set to.
  const concepts = useQuery({ queryKey: ["concepts"], queryFn: () => api.listConcepts() })

  const add = useMutation({
    mutationFn: () => {
      const target = {
        // A `concept` rule names the concept itself; a `record` rule scoped to a
        // concept uses `conceptId` — "records IN Deals", not "the Deals concept".
        resourceId: targetId && resourceType === "concept" ? targetId : null,
        conceptId: targetId && resourceType === "record" ? targetId : null,
      }
      return editingId
        ? api.updateRule({ ruleId: editingId, effect, actions, resourceType, ...target })
        : api.addRule({ roleId: role.id, effect, actions, resourceType, ...target })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["rules", role.id] })
      // Collapse on success: the saved rule is now visible in the table above, which
      // is the confirmation. Leaving the form open invites an accidental duplicate.
      setAdding(false)
      resetDraft()
    },
  })

  const remove = useMutation({
    mutationFn: (ruleId: string) => api.removeRule(ruleId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["rules", role.id] }),
  })

  const toggle = (a: AccessActionName) =>
    setActions((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]))

  const conceptName = (id: string) => (concepts.data ?? []).find((c) => c.id === id)?.name
  const scopeLabel = (r: {
    resourceId: string | null
    conceptId: string | null
    condition: unknown
  }) => scopeLabelFor(r, conceptName)

  return (
    <Modal onClose={onClose} title={`Rules — ${role.name}`} size="wide">
      <div className="space-y-6">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Rules grant access <span className="text-foreground">on top of</span> what each item
          already allows by default. A <span className="text-foreground">Deny</span> always wins,
          whatever else grants access.
        </p>

        {rules.isPending ? (
          <Spinner />
        ) : rules.data && rules.data.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Effect</TableHead>
                <TableHead>Can</TableHead>
                <TableHead>On</TableHead>
                <TableHead className="w-40">Scope</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupRules(rules.data).flatMap((group) => [
                // A group header row rather than nested tables: one set of column
                // widths keeps Effect/Can/On/Scope aligned all the way down.
                <TableRow key={`h-${group.label}`} className="hover:bg-transparent">
                  <TableCell
                    colSpan={5}
                    className="bg-muted/40 py-2 text-xs font-medium tracking-wide text-muted-foreground"
                  >
                    {group.label}
                    <span className="ml-2 font-normal opacity-70">{group.rules.length}</span>
                  </TableCell>
                </TableRow>,
                ...group.rules.map((r) => (
                  <TableRow
                    key={r.id}
                    // The whole row opens the editor; the remove button stops the event
                    // so a delete never reads as "edit this".
                    className={`cursor-pointer ${editingId === r.id ? "bg-accent" : ""}`}
                    onClick={() => startEditing(r)}
                  >
                    <TableCell>
                      <Badge tone={r.effect === "deny" ? "red" : "green"}>
                        {r.effect === "deny" ? "Deny" : "Allow"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium text-foreground">
                      {actionsLabel(r.actions)}
                    </TableCell>
                    <TableCell>{RESOURCE_LABEL.get(r.resourceType) ?? r.resourceType}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {/* "Scope" answers "which ones?" — a raw `(any)` or a truncated
                          uuid told the reader a rule was narrowed, but not to what,
                          which is the one thing they need. */}
                      {scopeLabel(r)}
                    </TableCell>
                    <TableCell>
                      <IconButton
                        aria-label={`Remove ${actionsLabel(r.actions)} on ${
                          RESOURCE_LABEL.get(r.resourceType) ?? r.resourceType
                        }`}
                        title="Remove rule"
                        variant="danger"
                        onClick={(e) => {
                          e.stopPropagation()
                          remove.mutate(r.id)
                        }}
                        disabled={remove.isPending}
                      >
                        <X size={14} />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                )),
              ])}
            </TableBody>
          </Table>
        ) : (
          <div className="rounded-lg border border-dashed px-6 py-8 text-center">
            <p className="text-sm font-medium">No rules yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              This role grants nothing beyond what every member already sees.
            </p>
          </div>
        )}
        <Feedback error={remove.error ? roleMsg(remove.error) : undefined} />

        {!adding ? (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus size={15} />
            Add rule
          </Button>
        ) : (
          <div className="space-y-4 rounded-lg border p-6">
            <span className="block text-sm font-medium">
              {editingId ? "Edit rule" : "Add a rule"}
            </span>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Effect">
                <Select value={effect} onValueChange={(v) => setEffect(v as "allow" | "deny")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="allow">Allow</SelectItem>
                    <SelectItem value="deny">Deny — always wins</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Applies to">
                <Select
                  value={resourceType}
                  onValueChange={(v) => {
                    setResourceType(v as AccessResourceType)
                    // Drop the target: a concept id is meaningless against `dashboard`,
                    // and carrying it over would silently scope the new rule.
                    setTargetId("")
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Grouped, because eleven flat engine words are a lookup table, not
                      a menu someone can scan. */}
                    {RESOURCE_GROUPS.map((g) => (
                      <SelectGroup key={g.label}>
                        <SelectLabel>{g.label}</SelectLabel>
                        {g.items.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {resourceType === "concept" || resourceType === "record" ? (
              <Field
                label={resourceType === "record" ? "In which concept?" : "Which concept?"}
                hint={
                  resourceType === "record"
                    ? "Leave as All to cover records everywhere."
                    : "Leave as All to cover every concept."
                }
              >
                <Select
                  value={targetId || "__all"}
                  onValueChange={(v) => setTargetId(v === "__all" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Radix forbids an empty SelectItem value, so "all" rides a
                      sentinel mapped back to "" — the project's standard workaround. */}
                    <SelectItem value="__all">All</SelectItem>
                    {(concepts.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field label="Can" hint="Pick one or more.">
              <div className="flex flex-wrap gap-1.5">
                {ACTIONS.map((a) => (
                  <ToggleChip
                    key={a.id}
                    pressed={actions.includes(a.id)}
                    onPressedChange={() => toggle(a.id)}
                  >
                    {a.label}
                  </ToggleChip>
                ))}
              </div>
            </Field>
            <div className="flex items-center gap-3">
              <Button
                onClick={() => add.mutate()}
                disabled={add.isPending || actions.length === 0}
                size="sm"
              >
                {add.isPending
                  ? editingId
                    ? "Saving…"
                    : "Adding…"
                  : editingId
                    ? "Save changes"
                    : "Add rule"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setAdding(false)
                  resetDraft()
                  add.reset()
                }}
                disabled={add.isPending}
              >
                Cancel
              </Button>
              {/* The one thing a reader can get badly wrong: thinking a `view` rule is
                how you open a restricted concept to everyone. It isn't — it outranks
                the default, which is why no preset carries one. */}
              {actions.includes("view") ? (
                <span className="text-xs text-muted-foreground">
                  A View rule overrides the item's own default visibility.
                </span>
              ) : null}
            </div>
            <Feedback error={add.error ? roleMsg(add.error) : undefined} />
          </div>
        )}
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
