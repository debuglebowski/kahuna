import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MoreHorizontal, Plus, Power, Star, Trash2 } from "lucide-react"
import { useState } from "react"
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  FilterInput,
  InfoHint,
  Input,
  Modal,
  Spinner,
} from "../../components/ui"
import { type AccessRole, api } from "../../lib/api"
import { Feedback } from "./parts"
import { PermissionPane } from "./permissions/PermissionPane"
import { type ItemSource, PANES } from "./permissions/panes"
import { SettingsHeading } from "./SettingsLayout"

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

/**
 * A pane's heading — what this tab is, and one line on what it decides.
 *
 * Shared by every pane (the role's own settings and the nine permission tabs) so
 * they open at the same height and in the same shape. Before this the content
 * column started with whatever that pane happened to render first — a table on
 * one, a paragraph on another — and the rail's highlight pointed at something that
 * began differently every time you clicked.
 */
function PaneHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="space-y-1">
      <h3 className="font-medium text-sm">{title}</h3>
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
  { label: "Permissions", items: PANES.map((p) => ({ id: p.id, label: p.label })) },
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

  // Every pane's rows, loaded with the modal rather than on tab change: they are
  // small, already-cached lists, and a spinner between rail clicks makes an overview
  // screen feel like navigation.
  const concepts = useQuery({ queryKey: ["concepts"], queryFn: () => api.listConcepts() })
  const dashboards = useQuery({
    queryKey: ["dashboards", "all"],
    queryFn: () => api.listAllDashboards(),
  })
  const views = useQuery({ queryKey: ["views"], queryFn: () => api.listViews() })
  const automations = useQuery({
    queryKey: ["automations", "all"],
    queryFn: () => api.listAutomations({ includeArchived: true }),
  })

  /**
   * Rows + loading state for one pane.
   *
   * Concepts back the Concepts & records pane on BOTH its halves — the records
   * columns are scoped by concept, so the row axis is the same list either way,
   * which is the whole reason the two panes merged.
   */
  const itemsFor = (
    source: ItemSource | undefined,
  ): { items: ReadonlyArray<{ id: string; name: string }>; busy: boolean } => {
    switch (source) {
      case "dashboards":
        return {
          items: (dashboards.data ?? []).map((d) => ({ id: d.id, name: d.name })),
          busy: dashboards.isPending,
        }
      case "views":
        return {
          items: (views.data ?? []).map((v) => ({ id: v.id, name: v.name })),
          busy: views.isPending,
        }
      case "automations":
        return {
          items: (automations.data ?? []).map((x) => ({ id: x.id, name: x.name })),
          busy: automations.isPending,
        }
      case "concepts":
        return {
          items: (concepts.data ?? []).map((c) => ({ id: c.id, name: c.name })),
          busy: concepts.isPending,
        }
      // A cards-only pane has no rows to fetch and nothing to wait for.
      default:
        return { items: [], busy: false }
    }
  }

  const current = PANES.find((p) => p.id === area) ?? null

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
          ) : !current ? (
            <Spinner />
          ) : (
            <div className="space-y-4">
              <PaneHeading title={current.label} subtitle={current.subtitle} />
              {rules.isPending ? (
                <Spinner />
              ) : (
                <PermissionPane
                  // Remount per pane: the pane holds a draft, and carrying one across
                  // a rail click would offer to save answers from a different tab.
                  key={current.id}
                  pane={current}
                  roleId={role.id}
                  rules={rules.data ?? []}
                  items={itemsFor(current.table?.items).items}
                  loading={itemsFor(current.table?.items).busy}
                  parentRules={role.basedOn ? parentRules.data : undefined}
                  parentLabel={basedOnParent?.name}
                />
              )}
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
                  {/* Every role is copyable, Admin included: with the wildcard gone its
                      rules are an ordinary list of allows, so "start from Admin and take
                      things away" produces a role that stays fully editable. Cross-category
                      copies are offered too — "like Member, but for automations". */}
                  {all.map((r) => (
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
