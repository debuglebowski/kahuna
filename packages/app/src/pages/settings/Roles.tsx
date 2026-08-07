import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MoreHorizontal, Plus, Power, Star, Trash2, X } from "lucide-react"
import { type ReactNode, useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  FilterInput,
  IconButton,
  InfoHint,
  Input,
  Modal,
  Spinner,
  ToggleChip,
} from "../../components/ui"
import { type AccessActionName, type AccessResourceType, type AccessRole, api } from "../../lib/api"
import { PermissionMatrix, type ScopeBy } from "./PermissionMatrix"
import { PermissionsPrototype } from "./PermissionsPrototype"
import { Feedback } from "./parts"
import { SettingsHeading } from "./SettingsLayout"

/**
 * Role management — the editor for the access model's reusable half.
 *
 * A role is a named bag of rules. An actor may hold any number of roles — a policy
 * is the union of its allows — so nothing here is a tier.
 *
 * ── TWO SECTIONS AND A DIVIDER, NOT A BADGE ──────────────────────────────────
 *
 * User roles and Automation roles, each cut into a managed half and a custom
 * half. The split carries what a per-row badge used to mumble: a managed role is
 * seeded so it cannot be deleted (the seed would put it back — turning it off is
 * the reversible equivalent), and an automation role can never be held by a
 * person. That second one is enforced by the engine, so showing bot roles among
 * people roles was inviting an action that would be refused — which is why KIND
 * is the outer cut and managed-ness the inner one.
 *
 * `configure`-gated as a whole: the rules inside a role are the sensitive part. Role
 * NAMES are readable by any member and render as pills on /members.
 */

/**
 * Actions in the order they escalate — view, then the write verbs, then the two that
 * are admin-only by default. Not alphabetical: the list is read as "how much power is
 * this?", so `delete` and `configure` sitting last is information.
 *
 * `"share"` is deliberately absent: sharing was removed (the mechanism for "this
 * person, specifically" is now a personal role, not a per-resource grant). The wire
 * value stays in `AccessActionName` — old rules still carry it — but nothing in this
 * editor offers to grant it.
 */
const ACTIONS: ReadonlyArray<{ id: AccessActionName; label: string; hint: string }> = [
  { id: "view", label: "View", hint: "Read it" },
  { id: "create", label: "Create", hint: "Add new ones" },
  { id: "edit", label: "Edit", hint: "Change existing ones" },
  { id: "archive", label: "Archive", hint: "Hide, restorably" },
  { id: "delete", label: "Delete", hint: "Destroy permanently" },
  { id: "configure", label: "Configure", hint: "Change its setup" },
]

/**
 * Resources grouped the way someone thinks about them, with plain-English names —
 * the wire values (`record`, `dashboard`, `view`) are engine vocabulary and mean
 * little on their own.
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
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "dashboard", label: "Dashboards", hint: "Widget canvases" },
      { id: "view", label: "Sidebar views", hint: "Nav layouts" },
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

/**
 * The rail: one grid per area, plus the full rule list.
 *
 * `actions` is NOT the full six everywhere, and that is the point. A column only
 * appears where the engine actually decides that action against that resource — a
 * cell that writes a rule nothing ever consults is worse than no cell, because it
 * reads as a permission that was granted. Dashboards and views resolve view/edit/
 * delete per row; automations now do too; a `record` rule is only ever consulted for
 * `view`, so the Records grid has the one column.
 *
 * "Other" holds only what NO grid owns: the resource types with no item list
 * (tasks, notes, members, the org itself) and conditional rules, which have
 * nowhere to live in a cell. Everything a grid can express — including
 * each area's DEFAULT, which is that area's untargeted rule — is edited in the area
 * itself, so there is exactly one place to change any given rule.
 */
interface Area {
  readonly id: string
  readonly label: string
  /**
   * One line under the heading: what the permissions in this pane decide.
   *
   * The rail entry is a single word, and a word cannot say whether the table
   * under it governs the TYPE or the rows inside it — "Concepts" and "Records"
   * are two panes a reader has to open before they can tell apart. Phrased as
   * "who can …", because that is the question every one of these answers.
   *
   * Distinct from `note`, which stays behind the ⓘ: this says what the pane is
   * FOR, the note warns about how it behaves. One is worth reading every visit,
   * the other once.
   */
  readonly subtitle: string
  readonly resourceType: AccessResourceType
  /** "concept" when the rows are CONTAINERS rather than the resources themselves. */
  readonly scopeBy?: ScopeBy
  readonly itemsLabel: string
  readonly actions: ReadonlyArray<AccessActionName>
  readonly note?: string
  /** Plural noun for the resource, when the rows are named something else. */
  readonly resourceNoun?: string
}

const AREAS: ReadonlyArray<Area> = [
  {
    id: "concept",
    label: "Concepts",
    subtitle:
      "Who can reach the types this workspace is built from, and who can change how they are set up, archive them, or delete them along with everything inside.",
    resourceType: "concept",
    itemsLabel: "Concept",
    actions: ["view", "archive", "delete", "configure"],
    note: "Configure covers the concept and its fields. View decides whether the concept is reachable at all.",
  },
  {
    id: "record",
    label: "Records",
    subtitle:
      "Who can see the entries stored inside each concept. These decide the contents rather than the type, so a concept can stay reachable while the records in it are hidden.",
    resourceType: "record",
    scopeBy: "concept",
    itemsLabel: "Concept",
    resourceNoun: "records",
    actions: ["view"],
    note: "Each row is a concept; the cell covers every record in it. Denying view here hides the records while leaving the concept itself reachable.",
  },
  {
    id: "dashboard",
    label: "Dashboards",
    subtitle:
      "Who can open each dashboard, change the widgets on it, and delete it. Answered per dashboard, so a role can be given one and kept out of the rest.",
    resourceType: "dashboard",
    itemsLabel: "Dashboard",
    actions: ["view", "edit", "delete"],
    note: "By default a dashboard is visible if it is shared with the org, or personal and yours. These are the exceptions to that.",
  },
  {
    id: "view",
    label: "Sidebar views",
    subtitle:
      "Who can open each sidebar layout, change what it lists and in what order, and delete it. Answered per view, so a role can be limited to the ones it needs.",
    resourceType: "view",
    itemsLabel: "Sidebar view",
    actions: ["view", "edit", "delete"],
  },
  {
    id: "automation",
    label: "Automations",
    subtitle:
      "Who can see each automation, change what sets it off and what it does, and archive or delete it once it exists.",
    resourceType: "automation",
    itemsLabel: "Automation",
    actions: ["view", "edit", "archive", "delete"],
    note: "Automations are readable by anyone and editable by admins by default, so a deny here is the lever that narrows one.",
  },
]

/** The rail entry for everything no grid covers. */
const OTHER_AREA = "all" as const

/** Resource types an area grid owns. A non-conditional, TARGETED rule of one of
 *  these types is edited there and is therefore hidden from Other — listing it
 *  in both places would give the same rule two editors that disagree about
 *  what a blank cell means. */
const GRIDDED = new Set<string>(AREAS.map((a) => a.resourceType))

/**
 * Is this rule owned by an area grid? Two things keep a rule out of the grid's
 * hands even when its type is gridded:
 *
 *  - a CONDITION — a cell has nowhere to put one, so a conditional rule stays
 *    in Other whatever its type.
 *  - being UNTARGETED (no `resourceId`/`conceptId`) — a blanket rule covers
 *    every row (including ones created later) at once; the grid can only show
 *    its EFFECT (the "Blocked" banner, P7), it has no cell that means "all of
 *    them" and therefore no way to edit or remove one. Leaving it in Other is
 *    what keeps it reachable at all — otherwise creating one would make it
 *    vanish from every editor in the same click.
 */
const inGrid = (r: {
  resourceType: string
  resourceId: string | null
  conceptId: string | null
  condition: unknown
}): boolean => GRIDDED.has(r.resourceType) && !r.condition && (!!r.resourceId || !!r.conceptId)

/** `role` isn't in `RESOURCE_GROUPS` — it has no picker entry, because role/rule
 *  editing is governed entirely by `configure` rather than being addable per
 *  resource (see `GRIDDED`'s doc). But an EXISTING rule on it (every managed
 *  role's preset carries one) still needs a real name here, or the "On" column
 *  falls back to the raw wire word. */
const RESOURCE_LABEL = new Map<string, string>([
  ...RESOURCE_GROUPS.flatMap((g) => g.items).map((r) => [r.id, r.label] as const),
  ["role", "Roles & permissions"],
])

/** Sort position, mirroring the picker's order (Concepts before Records, not
 *  alphabetical) so a rule sits where the reader expects it. */
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
 * A role's rules in picker order, so rules of the same type sit together.
 *
 * No category headings any more. Once every GRIDDED type moved to its own pane
 * the global "Other" list is at most a handful of rows across four types — and
 * three headers over five rows is more structure than the content has. The "On"
 * column already names each rule's type, which is what the headings were saying.
 *
 * An unrecognised `resourceType` (a newer server than this client, or a stray
 * pre-migration `field`/`bucket` row) sorts last rather than vanishing — a rule
 * the UI can't name is exactly the one worth showing.
 */
const sortRules = <T extends { readonly resourceType: string }>(
  rules: ReadonlyArray<T>,
): ReadonlyArray<T> =>
  [...rules].sort(
    (a, b) => (RESOURCE_RANK.get(a.resourceType) ?? 99) - (RESOURCE_RANK.get(b.resourceType) ?? 99),
  )
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
  if (raw.includes("managed role can't be deleted"))
    return "Managed roles can't be deleted — turn this one off instead."
  if (raw.includes("role not found")) return "That role no longer exists."
  // Anything else: pass the server's own text through when it looks like prose (the
  // engine's messages are written for humans), else a neutral fallback.
  return raw && !raw.trimStart().startsWith("{") ? raw : "Something went wrong."
}

/** Shown under a gridded area's own grid, when its "other rules" section has
 *  nothing in it yet. Generic on purpose — one line that reads the same for
 *  Concepts, Dashboards or any of the five, so five bespoke variants don't
 *  drift out of sync with what the section actually does. */
const AREA_OTHER_HINT =
  "Rules the grid above can't represent: untargeted (covers every one, including ones made later) or with a condition."

/** The global "Other" destination's blurb: PRECEDENCE only. What the pane
 *  covers is now its subtitle ({@link OTHER_SUBTITLE}) — the two said the same
 *  thing one line apart, and the half worth keeping here is the half a reader
 *  cannot infer from a rule list. */
const GLOBAL_OTHER_HINT: ReactNode = (
  <>
    A <span className="text-foreground">Deny</span> beats an Allow within THIS role. A role this
    person holds earlier, or their personal overrides, can still override it — see their access
    page.
  </>
)

/** {@link Area.subtitle}, for the one pane that is not an `Area`. The four types
 *  are the COMPLETE set, not a sample — which is the one thing this pane's
 *  reader needs, since "Other" otherwise sounds open-ended. */
const OTHER_SUBTITLE =
  "Who can act on everything with no table of its own: tasks, notes, members and the organisation's own settings. Written one rule at a time, since there is nothing here to lay out in a grid."

/**
 * A pane's heading — what this tab is, and one line on what it decides.
 *
 * Shared by all three kinds of pane (the role's own settings, an area grid, the
 * Other list) so they open at the same height and in the same shape. Before this
 * the content column started with whatever that pane happened to render first —
 * a table on one, a paragraph on another — and the rail's highlight pointed at
 * something that began differently every time you clicked.
 */
function PaneHeading({
  title,
  subtitle,
  note,
}: {
  title: string
  subtitle: string
  /** The trap worth reading once, kept behind the ⓘ. See {@link Area.subtitle}. */
  note?: string
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <h3 className="font-medium text-sm">{title}</h3>
        {note ? <InfoHint text={note} label={`${title} — more info`} /> : null}
      </div>
      {/* `text-balance` (`text-wrap: balance`) so the two or three lines come out
          near-equal instead of ending in one orphaned word. Safe at this length —
          browsers stop balancing past a handful of lines, and `max-w-prose` is
          what keeps the measure readable; balance only decides where the breaks
          fall inside it. */}
      <p className="max-w-prose text-sm text-balance text-muted-foreground">{subtitle}</p>
    </div>
  )
}

/**
 * Blanket & conditional rules — everything a grid cell cannot represent.
 *
 * Two shapes, one component. With `lockedType` set, it renders INLINE under
 * that type's own grid (`RuleEditor`'s per-area pane): compact, no type
 * picker, every rule it writes is that one type. Without it, it IS the global
 * "Other" destination: the full table, the type picker, the empty state — for
 * the resource types that have no grid of their own at all.
 *
 * Self-contained (owns its add/edit form and mutations) and remounted per
 * pane by the caller's `key`, exactly like `PermissionMatrix` — carrying a
 * draft across a rail click would offer to save a rule under the wrong type.
 */
function OtherRulesPanel({
  roleId,
  rules,
  concepts,
  lockedType,
}: {
  roleId: string
  /** Pre-filtered by the caller: exactly what this instance should show. */
  rules: ReadonlyArray<{
    readonly id: string
    readonly effect: "allow" | "deny"
    readonly actions: ReadonlyArray<string>
    readonly resourceType: string
    readonly resourceId: string | null
    readonly conceptId: string | null
    readonly condition: unknown
  }>
  concepts: ReadonlyArray<{ readonly id: string; readonly name: string }>
  /** Set inside a gridded area's own pane: hides the type picker and locks
   *  every rule this instance writes to that one type. Unset only for the
   *  global "Other" pane, whose picker offers the UNGRIDDED types. */
  lockedType?: AccessResourceType
}) {
  const qc = useQueryClient()
  const compact = lockedType !== undefined
  const [effect, setEffect] = useState<"allow" | "deny">("allow")
  const [resourceType, setResourceType] = useState<AccessResourceType>(lockedType ?? "task")
  const [actions, setActions] = useState<ReadonlyArray<AccessActionName>>(["view"])
  // "" = every one of that type. Only concept-shaped rules can name a target here;
  // a record is picked from the record's own Share dialog, not from a role.
  const [targetId, setTargetId] = useState("")
  const [adding, setAdding] = useState(false)
  /** null while adding; the rule's id while editing one. Drives the form's copy and
   *  which mutation the submit runs. */
  const [editingId, setEditingId] = useState<string | null>(null)

  const resetDraft = () => {
    setEffect("allow")
    setResourceType(lockedType ?? "task")
    setTargetId("")
    setActions(["view"])
    setEditingId(null)
  }

  /** Open the form on an existing rule, prefilled. `*` has no chip, so a wildcard rule
   *  loads with every action selected — the closest faithful representation, and
   *  saving it writes those actions explicitly rather than silently keeping `*`. */
  const startEditing = (r: (typeof rules)[number]) => {
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
        : api.addRule({ roleId, effect, actions, resourceType, ...target })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["rules", roleId] })
      // Collapse on success: the saved rule is now visible in the table above, which
      // is the confirmation. Leaving the form open invites an accidental duplicate.
      setAdding(false)
      resetDraft()
    },
  })

  const remove = useMutation({
    mutationFn: (ruleId: string) => api.removeRule(ruleId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["rules", roleId] }),
  })

  const toggle = (a: AccessActionName) =>
    setActions((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]))

  const conceptName = (id: string) => concepts.find((c) => c.id === id)?.name
  const scopeLabel = (r: {
    resourceId: string | null
    conceptId: string | null
    condition: unknown
  }) => scopeLabelFor(r, conceptName)

  /** The picker's options. Unset (global Other) only: the UNGRIDDED types — a
   *  gridded one now has its own dedicated pane for exactly this shape of
   *  rule, so offering it here would give the same rule two editors again. */
  const pickerGroups = RESOURCE_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((r) => !GRIDDED.has(r.id)),
  })).filter((g) => g.items.length > 0)

  const rows = sortRules(rules)

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      {compact ? (
        rules.length > 0 || adding ? (
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Other rules
            {rules.length > 0 ? (
              <span className="font-normal opacity-70">{rules.length}</span>
            ) : null}
          </div>
        ) : null
      ) : (
        <p className="max-w-prose text-sm text-muted-foreground">{GLOBAL_OTHER_HINT}</p>
      )}

      {rules.length > 0 ? (
        <Table>
          {/* Same header treatment as the matrix above it — quiet small-caps, no
              fill. Two tables in one pane wearing two different header styles is
              most of what reads as "borders everywhere". */}
          <TableHeader>
            <TableRow className="border-b hover:bg-transparent">
              <TableHead className="w-28 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Effect
              </TableHead>
              <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Can
              </TableHead>
              {compact ? null : (
                <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  On
                </TableHead>
              )}
              <TableHead className="w-40 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Scope
              </TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
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
                {compact ? null : (
                  <TableCell>{RESOURCE_LABEL.get(r.resourceType) ?? r.resourceType}</TableCell>
                )}
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
            ))}
          </TableBody>
        </Table>
      ) : compact ? (
        <p className="text-sm text-muted-foreground">{AREA_OTHER_HINT}</p>
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
          {compact ? "Add exception" : "Add rule"}
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
            {/* Locked (a gridded area's own pane): no picker at all, every rule
                this instance writes is `lockedType` — that's the whole point of
                being here instead of in the global Other pane. */}
            {lockedType ? null : (
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
                    {/* Grouped, because a flat list of engine words is a lookup
                        table, not a menu someone can scan. Gridded types are
                        omitted here — each has its own pane for this exact
                        shape of rule now. */}
                    {pickerGroups.map((g) => (
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
            )}
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
                  {concepts.map((c) => (
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
                A View rule overrides the record's own default visibility.
              </span>
            ) : null}
          </div>
          <Feedback error={add.error ? roleMsg(add.error) : undefined} />
        </div>
      )}
    </div>
  )
}

/**
 * The ROLE itself — everything about it that is not a rule.
 *
 * Its own pane rather than a strip above the grid: name, description and `based
 * on` belong to the role, and rendered above whichever area was open they read
 * as properties of THAT area. It is also where `based on` stops being a lone
 * control with nowhere to live.
 *
 * `saved` mirrors what the server last confirmed, because the `role` prop is a
 * snapshot taken when the modal opened and never changes — comparing against it
 * would leave the form permanently "dirty" after the first save.
 */
function GeneralPane({
  role,
  basedOnValue,
  basedOnOptions,
  onBasedOn,
  basedOnPending,
  basedOnError,
  onRenamed,
}: {
  role: AccessRole
  basedOnValue: string | null
  basedOnOptions: ReadonlyArray<AccessRole>
  onBasedOn: (next: string | null) => void
  basedOnPending: boolean
  basedOnError?: unknown
  /** So the modal title follows a rename rather than showing the old name. */
  onRenamed: (name: string) => void
}) {
  const qc = useQueryClient()
  const [saved, setSaved] = useState({ name: role.name, description: role.description ?? "" })
  const [name, setName] = useState(saved.name)
  const [description, setDescription] = useState(saved.description)

  const save = useMutation({
    mutationFn: () =>
      api.updateRole(role.id, {
        name: name.trim(),
        description: description.trim() || null,
      }),
    onSuccess: (updated) => {
      setSaved({ name: updated.name, description: updated.description ?? "" })
      onRenamed(updated.name)
      void qc.invalidateQueries({ queryKey: ["roles"] })
    },
  })
  const dirty = name.trim() !== saved.name || description.trim() !== saved.description

  return (
    // Full width, like every other pane. The CONTROLS keep their own widths —
    // a name input as wide as the frame is a text box you can't judge the length
    // of — but the pane itself no longer stops two thirds of the way across and
    // leaves the rail pointing at nothing.
    <div className="space-y-5">
      <Field label="Name" className="max-w-xl">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        label="Description"
        hint="Shown under the name in the roles list."
        className="max-w-xl"
      >
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this role is for"
        />
      </Field>
      {/* Chain inheritance (P6): a role's OWN rules always beat what it inherits
          (see PolicyService's chain-depth precedence), so this adds a floor
          under the role rather than changing anything above it. Saved on
          change, not with the button — it rewrites the whole cascade, so it is
          its own act. */}
      <Field
        label="Based on"
        hint="Its rules apply wherever this role stays silent. This role's own rules always win."
      >
        <Select
          value={basedOnValue ?? NONE_BASED_ON}
          onValueChange={(v) => onBasedOn(v === NONE_BASED_ON ? null : v)}
          disabled={basedOnPending}
        >
          <SelectTrigger className="w-72">
            <SelectValue placeholder="Nothing" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_BASED_ON}>Nothing</SelectItem>
            {basedOnOptions.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Feedback error={basedOnError ? roleMsg(basedOnError) : undefined} />
      <div className="flex items-center gap-3 border-t pt-4">
        <Button
          size="sm"
          onClick={() => save.mutate()}
          disabled={!dirty || !name.trim() || save.isPending}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
        {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
        <Feedback error={save.error ? roleMsg(save.error) : undefined} />
      </div>
    </div>
  )
}

/** The rail entry for the role's own settings. */
const GENERAL_AREA = "general" as const

/** The rail entry for {@link PermissionsPrototype} — a second shape for the
 *  Concepts pane, wired to nothing. Delete this entry and the file with it once
 *  the layout question is settled either way. */
const PROTOTYPE_AREA = "prototype" as const

/** "Nothing" in the Based on picker. Radix reserves `""` for the placeholder and
 *  throws on an empty `SelectItem` value, so no-choice rides a sentinel — the
 *  same workaround as {@link NONE}. */
const NONE_BASED_ON = "__none"

/**
 * The rail: TWO groups, cut by what a pane edits rather than by what it edits
 * it ON.
 *
 * Settings is the role itself — its name, its description, what it inherits.
 * Permissions is every rule pane: the five area grids in escalation order, then
 * "Other rules" for the types with no grid of their own.
 *
 * The rule panes were previously filed under `RESOURCE_GROUPS`' own headings
 * (Data / Workspace / Collaboration / Administration), which put four headings
 * over six entries — the taxonomy that earns its keep in a picker of a dozen
 * types is pure chrome over a rail this short. The one cut a reader actually
 * makes here is "the role" vs "what it can do".
 */
const SIDEBAR_GROUPS: ReadonlyArray<{
  readonly label: string
  readonly items: ReadonlyArray<{ readonly id: string; readonly label: string }>
}> = [
  { label: "Settings", items: [{ id: GENERAL_AREA, label: "General" }] },
  {
    label: "Permissions",
    items: [
      ...AREAS.map((a) => ({ id: a.id, label: a.label })),
      { id: OTHER_AREA, label: "Other rules" },
    ],
  },
  // Scratch space, and labelled as such so nobody edits a role through it by
  // accident. Goes away with the prototype.
  { label: "Prototype", items: [{ id: PROTOTYPE_AREA, label: "Concepts & records" }] },
]

/**
 * The rule editor for ONE role — grids per resource area, plus the flat "Other"
 * list for everything ungridded. Entirely role-agnostic: it takes an `AccessRole`
 * and reads/writes only through `roleId`, so it works identically whether that
 * role came from the Roles list or is a member's personal role (Layer 1) — the
 * member access page reuses this component wholesale rather than rebuilding a
 * second rule editor.
 */
export function RuleEditor({ role, onClose }: { role: AccessRole; onClose: () => void }) {
  const qc = useQueryClient()
  const rules = useQuery({ queryKey: ["rules", role.id], queryFn: () => api.listRules(role.id) })
  // The `based on` PARENT's rules (P6), so a cell this role stays silent on can
  // name what the parent resolves — see `PermissionMatrix`'s `inheritedFrom`.
  const parentRules = useQuery({
    queryKey: ["rules", role.basedOn],
    queryFn: () => api.listRules(role.basedOn ?? ""),
    enabled: !!role.basedOn,
  })
  /** Which pane the rail is showing: the role's own settings, a per-area grid,
   *  or the full rule list. Opens on Concepts, not General — this modal is
   *  reached by clicking a role to edit its RULES; the name is the rarer edit. */
  const [area, setArea] = useState<string>("concept")
  /** Local, so the title follows a rename — `role` is a snapshot handed in when
   *  the modal opened and never changes. */
  const [roleName, setRoleName] = useState(role.name)

  // For the "Based on" picker — every OTHER role of the same kind. `listRoles`
  // already excludes personal roles (never a valid target) and this role itself
  // is filtered client-side below; the server re-checks everything (cycle, kind,
  // self, personal) regardless, since the picker's options are a convenience,
  // not the enforcement.
  //
  // Local state, not the `role` prop: `role` is a snapshot handed in when the
  // modal opened, and only `["roles"]` (the LIST) gets invalidated on save — the
  // prop itself never changes, so the picker would keep showing the old value
  // after a successful change without this.
  const [basedOnValue, setBasedOnValue] = useState<string | null>(role.basedOn)
  const allRoles = useQuery({ queryKey: ["roles"], queryFn: () => api.listRoles() })
  const basedOnMut = useMutation({
    mutationFn: (basedOn: string | null) => api.updateRole(role.id, { basedOn }),
    onSuccess: (updated) => {
      setBasedOnValue(updated.basedOn)
      void qc.invalidateQueries({ queryKey: ["roles"] })
    },
  })
  const basedOnOptions = (allRoles.data ?? []).filter(
    (r) => r.id !== role.id && r.kind === role.kind,
  )
  const basedOnParent = (allRoles.data ?? []).find((r) => r.id === basedOnValue)

  // Named targets for the picker AND for resolving ids in the table's Scope column.
  // Not gated on the selected type: the table needs names for rules that are already
  // there, whatever the form happens to be set to.
  const concepts = useQuery({ queryKey: ["concepts"], queryFn: () => api.listConcepts() })
  // The creation templates for every role; filtered to this one before use.
  const defaults = useQuery({
    queryKey: ["accessDefaults"],
    queryFn: () => api.listAccessDefaults(),
  })
  // The other grids' rows. All four load with the modal rather than on tab change: they
  // are small, already-cached lists, and a spinner between rail clicks makes an
  // overview screen feel like navigation.
  const dashboards = useQuery({
    queryKey: ["dashboards", "all"],
    queryFn: () => api.listAllDashboards(),
  })
  const views = useQuery({ queryKey: ["views"], queryFn: () => api.listViews() })
  const automations = useQuery({
    queryKey: ["automations", "all"],
    queryFn: () => api.listAutomations({ includeArchived: true }),
  })

  /** Rows + loading state for one area. Concepts back BOTH the concept grid and the
   *  record grid — the record grid's rows are the concepts its rules are scoped to. */
  const itemsFor = (
    a: Area,
  ): { items: ReadonlyArray<{ id: string; name: string }>; busy: boolean } => {
    switch (a.resourceType) {
      case "dashboard":
        return {
          items: (dashboards.data ?? []).map((d) => ({ id: d.id, name: d.name })),
          busy: dashboards.isPending,
        }
      case "view":
        return {
          items: (views.data ?? []).map((v) => ({ id: v.id, name: v.name })),
          busy: views.isPending,
        }
      case "automation":
        return {
          items: (automations.data ?? []).map((x) => ({ id: x.id, name: x.name })),
          busy: automations.isPending,
        }
      default:
        return {
          items: (concepts.data ?? []).map((c) => ({ id: c.id, name: c.name })),
          busy: concepts.isPending,
        }
    }
  }

  const current = AREAS.find((a) => a.id === area) ?? null
  /** The Concepts area, for the prototype pane to borrow. Non-null by
   *  construction — it is the first entry in `AREAS` — but read rather than
   *  indexed so deleting the prototype needs no other change. */
  const conceptArea = AREAS.find((a) => a.resourceType === "concept") ?? AREAS[0]!
  /** This area's blanket/conditional rules — the ones its grid can't show. */
  const otherRulesFor = (resourceType: AccessResourceType) =>
    (rules.data ?? []).filter((r) => r.resourceType === resourceType && !inGrid(r))
  /** What the global "Other" pane shows: every type with no grid of its own. */
  const ungriddedRules = (rules.data ?? []).filter((r) => !GRIDDED.has(r.resourceType))

  return (
    <Modal
      onClose={onClose}
      title={`Rules — ${roleName}`}
      size="wide"
      // Area rail. The grid is per-area by necessity — one matrix over every
      // resource type at once would have no meaningful row axis — so the areas
      // become navigation rather than another dropdown. It is the FRAME's
      // sidebar, so it runs the whole height of the modal beside the title.
      //
      // Settings leads it and is separated from Permissions: everything under
      // the second heading edits RULES, the one under the first edits the role
      // holding them.
      sidebar={
        <nav>
          {SIDEBAR_GROUPS.map((group, i) => (
            <div key={group.label} className={i > 0 ? "mt-4" : undefined}>
              <div className="mb-1 px-3 text-xs font-medium text-muted-foreground/70">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setArea(a.id)}
                    className={`block w-full rounded-md px-3 py-1.5 text-left text-sm transition ${
                      area === a.id
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      }
    >
      {/* `flex-1 min-h-0` + its own scroll: the wide modal is a fixed 90vh frame
          that does NOT scroll itself, so without this a long concept list is
          clipped rather than reachable. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-w-0 flex-1 space-y-6 overflow-y-auto pr-1">
          {area === GENERAL_AREA ? (
            <div className="space-y-4">
              <PaneHeading
                title="General"
                subtitle="The role itself: what it is called, the description shown beside it in the roles list, and which other role it falls back on wherever this one says nothing."
              />
              <GeneralPane
                role={role}
                basedOnValue={basedOnValue}
                basedOnOptions={basedOnOptions}
                onBasedOn={(next) => basedOnMut.mutate(next)}
                basedOnPending={basedOnMut.isPending}
                basedOnError={basedOnMut.error}
                onRenamed={setRoleName}
              />
            </div>
          ) : area === PROTOTYPE_AREA ? (
            // Concepts and Records as ONE pane — the prototype's whole point, so
            // it takes the concept list and nothing else. It writes nothing, so
            // it needs no role, no rules and no defaults.
            <div className="space-y-4">
              <PaneHeading
                title="Concepts &amp; records"
                subtitle="Who can see and change the entries stored under each type, and who can change or remove the type itself. One row per concept, covering both."
              />
              <PermissionsPrototype
                items={itemsFor(conceptArea).items}
                itemsLabel={conceptArea.itemsLabel}
                loading={itemsFor(conceptArea).busy}
              />
            </div>
          ) : current ? (
            <>
              <div className="space-y-4">
                <PaneHeading
                  title={current.label}
                  subtitle={current.subtitle}
                  note={current.note}
                />
                <PermissionMatrix
                  // Remount per area: the grid holds a draft, and carrying one across a
                  // rail click would offer to save cells from a different resource type.
                  key={current.id}
                  roleId={role.id}
                  resourceType={current.resourceType}
                  scopeBy={current.scopeBy}
                  items={itemsFor(current).items}
                  itemsLabel={current.itemsLabel}
                  actions={ACTIONS.filter((a) => current.actions.includes(a.id))}
                  rules={rules.data ?? []}
                  defaults={(defaults.data ?? []).filter((d) => d.roleId === role.id)}
                  resourceNoun={current.resourceNoun}
                  loading={rules.isPending || defaults.isPending || itemsFor(current).busy}
                  parentRules={role.basedOn ? parentRules.data : undefined}
                  parentLabel={basedOnParent?.name}
                />
              </div>
              {/* Blanket/conditional rules for THIS type, inline rather than in the
                  global "Other" pane — a rule here used to show up in two editors
                  (this grid's Default row AND a separate Other list entry) that
                  disagreed about what a blank cell meant. */}
              {rules.isPending ? null : (
                <OtherRulesPanel
                  key={`other-${current.id}`}
                  roleId={role.id}
                  rules={otherRulesFor(current.resourceType)}
                  concepts={concepts.data ?? []}
                  lockedType={current.resourceType}
                />
              )}
            </>
          ) : rules.isPending ? (
            <Spinner />
          ) : (
            <div className="space-y-4">
              <PaneHeading title="Other rules" subtitle={OTHER_SUBTITLE} />
              <OtherRulesPanel
                roleId={role.id}
                rules={ungriddedRules}
                concepts={concepts.data ?? []}
              />
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

/**
 * ── TURNING A ROLE OFF ───────────────────────────────────────────────────────
 *
 * Deactivating takes every rule the role carries away from everyone holding it, and
 * under a fail-closed model that reads as data disappearing rather than as a
 * permission changing. So the dialog does two things a plain confirm cannot: it says
 * how many people (or automations) are about to be affected, and it offers to move
 * them somewhere first.
 *
 * The move is OPTIONAL. "Off, and they get nothing" is a legitimate thing to want,
 * and forcing a replacement would make the dialog un-dismissable for an org that has
 * no other role yet. But it is never the silent default.
 */
function DeactivateDialog({
  role,
  roles,
  onClose,
}: {
  role: AccessRole
  roles: ReadonlyArray<AccessRole>
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [replacement, setReplacement] = useState("")
  const holders = useQuery({
    queryKey: ["roleHolders", role.id],
    queryFn: () => api.roleHolders(role.id),
  })
  const count = holders.data?.actors.length ?? 0

  const run = useMutation({
    mutationFn: async () => {
      // Move BEFORE turning off, so there is no window in which the holders have
      // neither role.
      if (replacement) await api.reassignRoleHolders(role.id, replacement)
      await api.updateRole(role.id, { active: false })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["roles"] })
      onClose()
    },
  })

  // Same category only — the engine refuses a cross-kind move, so offering one here
  // would be an error the reader could not have predicted.
  const options = roles.filter((r) => r.id !== role.id && r.kind === role.kind && r.active)
  const noun = role.kind === "automation" ? "automation" : "member"

  return (
    <Modal onClose={onClose} title={`Turn off ${role.name}?`}>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Its rules stop applying immediately. Assignments are kept, so turning it back on restores
          exactly what was there.
        </p>
        {holders.isPending ? (
          <Spinner />
        ) : count === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody holds this role.</p>
        ) : (
          <>
            <p className="text-sm">
              <span className="font-medium">
                {count} {noun}
                {count === 1 ? "" : "s"}
              </span>{" "}
              {count === 1 ? "holds" : "hold"} this role and will lose its access.
            </p>
            <Field
              label="Give them another role first"
              hint="Optional. They keep this one too, so turning it back on changes nothing."
            >
              <Select
                value={replacement || NONE}
                onValueChange={(v) => setReplacement(v === NONE ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Nothing — they lose this access</SelectItem>
                  {options.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </>
        )}
        <Feedback error={run.error ? roleMsg(run.error) : undefined} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? "Turning off…" : "Turn off"}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Radix REFUSES an empty `SelectItem` value — it reserves "" for "cleared, show the
 * placeholder" — and throws hard enough to take the whole route down. So "no choice"
 * rides a sentinel, the same workaround the rule form already uses for its All option.
 *
 * This is not hypothetical: the Start from picker shipped with `value=""` and crashed
 * the New custom role dialog on open, every time.
 */
const NONE = "__none"

/** One half of a section's card — the roles of that section's kind that are
 *  managed, or the ones that aren't. */
interface RoleGroup {
  readonly id: string
  /** One word: the section heading already said which KIND these are. */
  readonly label: string
  /** What the reader can do with them. Lives in the divider's hint, NOT on the
   *  divider line — a sentence there turned a structural label into a third
   *  competing line of prose. */
  readonly note: string
  /** Shown when the group has no rows and no filter is hiding them. Terse: the
   *  heading above already named what is missing. */
  readonly empty: string
  readonly managed: boolean
}

/**
 * TWO sections, cut by the axis that decides who may hold a role at all — and
 * inside each, a divider between the managed half and the custom half.
 *
 * Both axes have to reach the reader: kind (a role of the wrong one is refused
 * by the engine, not merely discouraged) and managed-ness (a managed role's
 * delete is refused, because the seed would put it back). Neither is visible
 * from a role's name.
 *
 * They are NOT two levels of card, though. The managed halves are fixed by the
 * seed — two user roles and exactly one automation role, forever — so a heading,
 * a hint and a box of their own would be chrome around something that never
 * changes. A divider row inside the one card carries the same cut for a
 * fraction of the weight.
 */
const SECTIONS: ReadonlyArray<{
  readonly id: string
  readonly label: string
  /** The section-level fact: who can hold these. The per-half advice lives on
   *  the divider rows instead. */
  readonly hint: string
  readonly kind: "user" | "automation"
  readonly groups: ReadonlyArray<RoleGroup>
}> = [
  {
    id: "user",
    label: "User roles",
    hint: "Held by people, never automations.",
    kind: "user",
    groups: [
      {
        id: "managed",
        label: "Managed",
        // Says what someone can DO with them, not where they came from. The old
        // copy ("seeded with the org … the seed would put one back") explained
        // our implementation to justify a restriction, which is not the reader's
        // problem.
        note: "Come with the app. Edit them or turn them off — they can't be deleted.",
        empty: "None.",
        managed: true,
      },
      {
        id: "custom",
        label: "Custom",
        note: "Made by you. Edit, turn off or delete them freely.",
        empty: "None yet.",
        managed: false,
      },
    ],
  },
  {
    id: "automation",
    label: "Automation roles",
    hint: "Held by automations, never people. A new automation starts on whichever of these is the default.",
    kind: "automation",
    groups: [
      {
        id: "managed",
        label: "Managed",
        note: "Comes with the app. Edit it or turn it off — it can't be deleted.",
        empty: "None.",
        managed: true,
      },
      {
        id: "custom",
        label: "Custom",
        note: "Made by you. Edit, turn off or delete them freely.",
        empty: "None yet.",
        managed: false,
      },
    ],
  },
]

/**
 * One role in the list. Lifted out of the render so the section → half → row
 * nesting stays legible; it holds no state and decides nothing — every act is a
 * callback, so the page keeps owning which dialog is open and what is in flight.
 */
function RoleRow({
  role,
  onOpen,
  onToggleDefault,
  onTurnOff,
  onTurnOn,
  onDelete,
  patching,
  /** Turning this one off would leave its category with no landing zone. */
  lastLandingZone,
}: {
  role: AccessRole
  onOpen: () => void
  onToggleDefault: () => void
  onTurnOff: () => void
  onTurnOn: () => void
  onDelete: () => void
  patching: boolean
  lastLandingZone: boolean
}) {
  return (
    <div
      className={`flex items-center gap-3 hover:bg-accent/50 ${role.active ? "" : "opacity-55"}`}
    >
      {/* The ROW opens the rules. A real <button> rather than a click handler on
          the div: this is the primary action, so it has to be reachable by
          keyboard and announced as one. */}
      {/* Name and description are deliberately DIFFERENT sizes. At the same size
          the pair read as two competing lines and made every row look twice as
          heavy as it is. */}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 px-4 py-3 text-left">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{role.name}</span>
          {role.active ? null : <Badge tone="gray">off</Badge>}
          {role.autoAssign ? <Badge tone="blue">Default</Badge> : null}
        </div>
        {role.description ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{role.description}</p>
        ) : null}
      </button>
      <div className="shrink-0 pr-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={`Actions for ${role.name}`}
            >
              <MoreHorizontal size={15} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* A full-access role can't be "not allowed" anything, so making it
                the default is still a real choice. */}
            <DropdownMenuItem disabled={!role.active || patching} onSelect={onToggleDefault}>
              <Star size={15} />
              {role.autoAssign ? "Remove as default" : "Set as default"}
            </DropdownMenuItem>
            {role.active ? (
              <DropdownMenuItem onSelect={onTurnOff}>
                <Power size={15} />
                Turn off
                {lastLandingZone ? (
                  <span className="ml-auto pl-2 text-xs text-muted-foreground">
                    the only default
                  </span>
                ) : null}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={patching} onSelect={onTurnOn}>
                <Power size={15} />
                Turn on
              </DropdownMenuItem>
            )}
            {/* A managed role's rules stay editable — only deletion is refused,
                because the seed pins by key and would re-create one. Turning it
                off is the reversible equivalent, which is why it sits right
                above. */}
            {role.managed ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 size={15} />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export function Roles() {
  const qc = useQueryClient()
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.listRoles() })
  const [filter, setFilter] = useState("")
  /** null = closed; otherwise the category the New custom role dialog is creating into. */
  const [creating, setCreating] = useState<"user" | "automation" | null>(null)
  const [name, setName] = useState("")
  /** "" = start from nothing. See the note on the picker. */
  const [startFrom, setStartFrom] = useState("")
  const [editing, setEditing] = useState<AccessRole | null>(null)
  const [deleting, setDeleting] = useState<AccessRole | null>(null)
  const [turningOff, setTurningOff] = useState<AccessRole | null>(null)

  const create = useMutation({
    mutationFn: () =>
      api.createRole(name.trim(), undefined, startFrom || undefined, creating ?? "user"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["roles"] })
      setCreating(null)
      setName("")
      setStartFrom("")
    },
  })
  const del = useMutation({
    mutationFn: (id: string) => api.deleteRole(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["roles"] })
      setDeleting(null)
    },
  })
  const patch = useMutation({
    mutationFn: (input: { id: string; autoAssign?: boolean; active?: boolean }) =>
      api.updateRole(input.id, { autoAssign: input.autoAssign, active: input.active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["roles"] }),
  })

  if (roles.isPending) return <Spinner />
  if (roles.error) return <Feedback error={roleMsg(roles.error)} />

  const all = roles.data ?? []
  const q = filter.trim().toLowerCase()
  const shown = all.filter((r) => !q || r.name.toLowerCase().includes(q))

  /** Would turning this one off leave its category with nowhere to land? A warning,
   *  never a refusal — an org may deliberately want new actors to start with nothing. */
  const isLastLandingZone = (r: AccessRole) =>
    r.autoAssign &&
    r.active &&
    all.filter((o) => o.kind === r.kind && o.autoAssign && o.active).length === 1

  return (
    <div className="space-y-8">
      {/* Filter and create sit ON the page title's line rather than in a toolbar
          row beneath it: the row was a full line of chrome carrying two controls,
          and the title line was empty to its right. `ownsHeading` on the nav item
          is what stops the layout drawing a second title. */}
      <SettingsHeading title="Roles">
        <FilterInput
          value={filter}
          onChange={setFilter}
          placeholder="Filter roles…"
          className="w-56"
        />
        {/* "Custom", because that is the only kind this button can make — a
            managed role is seeded, never created here. */}
        <Button size="sm" onClick={() => setCreating("user")}>
          <Plus size={15} />
          New custom role
        </Button>
      </SettingsHeading>

      {/* Three nested spacings, widest outermost, so the hierarchy is carried by
          air rather than by rules and fills: section → its two lists → the label
          above each list. Each section is wrapped in a subtle border. */}
      <div className="space-y-10">
        {SECTIONS.map((section) => {
          const groups = section.groups
            .map((g) => ({
              group: g,
              rows: shown.filter((r) => r.kind === section.kind && r.managed === g.managed),
            }))
            // An empty half still renders — "you have none yet" is information.
            // An empty half under an active filter is just noise.
            .filter((g) => g.rows.length > 0 || !q)
          if (groups.length === 0) return null
          return (
            <div key={section.id} className="space-y-4 rounded-xl border p-4">
              <div>
                <h3 className="font-medium text-sm">{section.label}</h3>
                <p className="text-xs text-muted-foreground">{section.hint}</p>
              </div>
              {/* A LIST EACH, not one list with bands across it. The managed and
                  custom halves answer different questions ("what came with the
                  app" / "what have we built"), and a filled divider row inside a
                  single card put a heavy horizontal rule through the middle of
                  the one thing the reader is scanning. */}
              <div className="space-y-5">
                {groups.map(({ group, rows }) => (
                  <div key={group.id} className="space-y-1.5">
                    <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                      {group.label}
                      <InfoHint text={group.note} label={`${group.label} roles — more info`} />
                    </div>
                    <Card>
                      <div className="divide-y">
                        {rows.length === 0 ? (
                          <p className="px-4 py-4 text-sm text-muted-foreground">{group.empty}</p>
                        ) : null}
                        {rows.map((r) => (
                          <RoleRow
                            key={r.id}
                            role={r}
                            onOpen={() => setEditing(r)}
                            onToggleDefault={() =>
                              patch.mutate({ id: r.id, autoAssign: !r.autoAssign })
                            }
                            onTurnOff={() => setTurningOff(r)}
                            onTurnOn={() => patch.mutate({ id: r.id, active: true })}
                            onDelete={() => setDeleting(r)}
                            patching={patch.isPending}
                            lastLandingZone={isLastLandingZone(r)}
                          />
                        ))}
                      </div>
                    </Card>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <Feedback error={patch.error ? roleMsg(patch.error) : undefined} />

      {creating ? (
        <Modal
          onClose={() => setCreating(null)}
          title={creating === "automation" ? "New custom automation role" : "New custom user role"}
        >
          <div className="space-y-3">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={creating === "automation" ? "e.g. Tickets only" : "e.g. Sales"}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) create.mutate()
              }}
            />
            {/* CATEGORY. Fixed at creation — flipping it later would strand every
                holder on the wrong side of the kind guard, so it is asked here or
                not at all. */}
            <Field label="For" hint="An automation role can only ever be held by an automation.">
              <Select
                value={creating}
                onValueChange={(v) => setCreating(v as "user" | "automation")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">People</SelectItem>
                  <SelectItem value="automation">Automations</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {/* START FROM. A role with nothing sees nothing — safe, but unusable
                until someone walks every concept and every action. This is the
                shortcut, and it must say SNAPSHOT: later changes to Member do not
                follow, and someone will expect them to. */}
            <Field
              label="Start from"
              hint="A copy of that role's access, taken now. Later changes to it won't follow."
            >
              <Select
                value={startFrom || NONE}
                onValueChange={(v) => setStartFrom(v === NONE ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>From scratch — no access until you grant it</SelectItem>
                  {all
                    // Copying a full-access role would mint a second one from a
                    // dropdown; `full_access` is a property of the role, not a name.
                    // Cross-category copies are offered: the rules are the same shape,
                    // and "like Member, but for automations" is a reasonable start.
                    .filter((r) => !r.fullAccess)
                    .map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
            <Feedback error={create.error ? roleMsg(create.error) : undefined} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreating(null)}>
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

      {turningOff ? (
        <DeactivateDialog role={turningOff} roles={all} onClose={() => setTurningOff(null)} />
      ) : null}

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
