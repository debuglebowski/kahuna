import type { AccessActionName, AccessResourceType } from "../../../lib/api"
import type { Answerable, Group, ScopeBy } from "./fold"

/**
 * WHAT EVERY TAB OFFERS, in one place.
 *
 * ── THE RULE THIS FILE EXISTS TO KEEP ────────────────────────────────────────
 *
 * An action appears here only where the engine actually decides it against that
 * resource type. A control that writes a rule nothing ever reads is worse than no
 * control at all, because it reads as a permission that was granted — and the old
 * freeform rule editor, which offered all six actions for every type, was exactly
 * that: `org: edit`, `member: view`, `record: delete` were all settable and all
 * inert. The pane can only offer what is listed below.
 *
 * Deliberately absent, and each for its own reason:
 *   share            dead for every type — not one call site anywhere.
 *   note / view      there is no global note list, so nothing would read it.
 *   concept / edit   renaming a concept is `configure`; there is no separate edit.
 *
 * ── QUESTIONS vs COLUMNS ─────────────────────────────────────────────────────
 *
 * A column needs a row, and a row needs a thing that exists. `create` on a concept
 * is decided against `{type:"concept"}` with no id — the concept does not exist when
 * the answer is needed — so it can only ever be blanket, and it is a card. `create`
 * on a RECORD is decided against its concept, so it is a column and Granularity
 * handles it like any other.
 *
 * The five types with no item list at all (task, note, member, role, org) are cards
 * all the way down: every action on them is decided untargeted, so a per-item row
 * would be meaningless and unwriteable.
 */

/** A blanket answer with no row — rendered as a card above the table. */
export interface Question {
  readonly resourceType: AccessResourceType
  readonly action: AccessActionName
  readonly title: string
  readonly description: string
}

/** A per-item answer — a table column. `group` is the header it sits under. */
export interface Column {
  readonly resourceType: AccessResourceType
  readonly action: AccessActionName
  readonly group: string
  readonly label: string
  readonly hint: string
  /**
   * Further answers this one cell writes, to the SAME state, for the same row.
   *
   * There is exactly one, and it is not a generalisation looking for a use: reaching
   * a concept (`concept`/`view`) and reading the records inside it (`record`/`view`)
   * are two separate decisions in the engine, and only the second had a column. A
   * role built from scratch could therefore be granted every record permission and
   * still not see the concept, with no cell anywhere to fix it.
   *
   * Folding them into one control is a deliberate trade: "reachable but empty" stops
   * being expressible from this screen. It remains expressible in the rules
   * themselves, and nothing here destroys one that already exists — the pair is only
   * written when the cell is touched.
   */
  readonly also?: ReadonlyArray<Answerable>
}

/** Which list backs a pane's rows. */
export type ItemSource = "concepts" | "dashboards" | "views" | "automations"

export interface Pane {
  readonly id: string
  readonly label: string
  readonly subtitle: string
  readonly questions: ReadonlyArray<Question>
  /** Absent ⇒ cards only: no table, and no Granularity control to reshape one. */
  readonly table?: {
    readonly itemsLabel: string
    readonly items: ItemSource
    readonly columns: ReadonlyArray<Column>
    /** Per resource type, when it differs from the default. The records half of the
     *  Concepts pane is scoped by CONTAINER: its rows are concepts, its rules mean
     *  "the records inside". */
    readonly scopeBy?: Partial<Record<AccessResourceType, ScopeBy>>
  }
  /** Shown above the questions when it would otherwise be a surprise — a caveat
   *  about what the answers can and cannot reach. */
  readonly caveat?: string
}

/** What each group header means. Keyed by the `group` on a {@link Column}. */
export const GROUP_HINTS: Record<string, string> = {
  Records:
    "The entries stored under this concept. Nothing here touches how the concept itself is set up.",
  "The concept":
    "The type itself — how it is set up, and whether it exists at all. Separate from the records inside it, so a role can be trusted with the data and kept away from the schema.",
}

export const PANES: ReadonlyArray<Pane> = [
  {
    id: "concept",
    label: "Concepts & records",
    subtitle:
      "Who can see and change the entries stored under each type, and who can change or remove the type itself. One row per concept, covering both.",
    questions: [
      {
        resourceType: "concept",
        action: "create",
        title: "Create concepts",
        description:
          "Add new types to the workspace. This one can never be per-concept — the concept doesn't exist yet when the answer is needed.",
      },
    ],
    table: {
      itemsLabel: "Concept",
      items: "concepts",
      scopeBy: { record: "concept" },
      columns: [
        {
          resourceType: "record",
          action: "view",
          group: "Records",
          // Also carries `concept`/`view` — see `Column.also`. Without the pair this
          // cell grants reading the rows of a concept the role cannot open.
          also: [{ resourceType: "concept", action: "view" }],
          label: "View",
          hint: "See this concept and the entries inside it. Denying it hides the concept entirely, not just its contents.",
        },
        {
          resourceType: "record",
          action: "create",
          group: "Records",
          label: "Create",
          hint: "Add entries to this concept. Decided against the concept, so a role can be allowed to add to one and not another.",
        },
        {
          resourceType: "record",
          action: "edit",
          group: "Records",
          label: "Edit",
          hint: "Change the entries inside this concept, without being able to change how the concept is set up.",
        },
        {
          resourceType: "concept",
          action: "configure",
          group: "The concept",
          label: "Configure",
          hint: "See and change how the concept is set up: its name, its fields, its title field, its settings.",
        },
        {
          resourceType: "concept",
          action: "archive",
          group: "The concept",
          label: "Archive",
          hint: "Hide the concept without destroying it. Reversible.",
        },
        {
          resourceType: "concept",
          action: "delete",
          group: "The concept",
          label: "Delete",
          hint: "Destroy the concept permanently, along with every record in it.",
        },
      ],
    },
  },
  {
    id: "dashboard",
    label: "Dashboards",
    subtitle:
      "Who can open each dashboard, change the widgets on it, and delete it. Answered per dashboard, so a role can be given one and kept out of the rest.",
    caveat:
      "A personal dashboard can only be reached by a rule that names it. The All row covers the shared ones — it cannot open somebody's own.",
    questions: [
      {
        resourceType: "dashboard",
        action: "create",
        title: "Create dashboards",
        description:
          "Make new dashboards. There is no per-dashboard version of this — the dashboard doesn't exist yet when the answer is needed.",
      },
    ],
    table: {
      itemsLabel: "Dashboard",
      items: "dashboards",
      columns: [
        {
          resourceType: "dashboard",
          action: "view",
          group: "Dashboard",
          label: "View",
          hint: "Open it and see what it shows.",
        },
        {
          resourceType: "dashboard",
          action: "edit",
          group: "Dashboard",
          label: "Edit",
          hint: "Change its widgets, its layout and its name.",
        },
        {
          resourceType: "dashboard",
          action: "delete",
          group: "Dashboard",
          label: "Delete",
          hint: "Remove it permanently.",
        },
      ],
    },
  },
  {
    id: "view",
    label: "Sidebar views",
    subtitle:
      "Who can open each sidebar layout, change what it lists and in what order, and delete it. Answered per view, so a role can be limited to the ones it needs.",
    caveat:
      "A personal view can only be reached by a rule that names it. The All row covers the shared ones — it cannot open somebody's own.",
    questions: [
      {
        resourceType: "view",
        action: "create",
        title: "Create sidebar views",
        description:
          "Make new sidebar layouts. There is no per-view version of this — the view doesn't exist yet when the answer is needed.",
      },
    ],
    table: {
      itemsLabel: "Sidebar view",
      items: "views",
      columns: [
        {
          resourceType: "view",
          action: "view",
          group: "Sidebar view",
          label: "View",
          hint: "See it in the sidebar switcher and open it.",
        },
        {
          resourceType: "view",
          action: "edit",
          group: "Sidebar view",
          label: "Edit",
          hint: "Change what it lists, and in what order.",
        },
        {
          resourceType: "view",
          action: "delete",
          group: "Sidebar view",
          label: "Delete",
          hint: "Remove it permanently.",
        },
      ],
    },
  },
  {
    id: "automation",
    label: "Automations",
    subtitle:
      "Who can see each automation, change what sets it off and what it does, and archive or delete it.",
    // Reads and the three write actions now behave like every other tab — silence
    // denies. What remains true, and would otherwise surprise, is the SECOND gate:
    // every automation write is additionally gated on org configuration at the
    // request boundary, so an Allow here is necessary but not sufficient.
    caveat:
      "Changing an automation also requires permission to configure the organisation, which is granted on its own tab. An Allow here is required for it, not a substitute.",
    questions: [],
    table: {
      itemsLabel: "Automation",
      items: "automations",
      columns: [
        {
          resourceType: "automation",
          action: "view",
          group: "Automation",
          label: "View",
          hint: "See it in the automations list and open it.",
        },
        {
          resourceType: "automation",
          action: "edit",
          group: "Automation",
          label: "Edit",
          hint: "Change its trigger, its conditions and what it does.",
        },
        {
          resourceType: "automation",
          action: "archive",
          group: "Automation",
          label: "Archive",
          hint: "Turn it off without destroying it. Reversible.",
        },
        {
          resourceType: "automation",
          action: "delete",
          group: "Automation",
          label: "Delete",
          hint: "Remove it permanently.",
        },
      ],
    },
  },
  {
    id: "task",
    label: "Tasks",
    subtitle:
      "Who can work with tasks that belong to the workspace rather than to a record. A task on a record is governed by that record instead.",
    questions: [
      {
        resourceType: "task",
        action: "view",
        title: "View the task list",
        description:
          "See the workspace-wide task list. Tasks attached to a record are decided by whether that record is visible, not here.",
      },
      {
        resourceType: "task",
        action: "create",
        title: "Create tasks",
        description:
          "Add tasks that belong to the workspace rather than to a record. Adding one to a record needs access to that record instead.",
      },
    ],
  },
  {
    id: "note",
    label: "Notes",
    subtitle:
      "Who can add notes that belong to the workspace rather than to a record. A note on a record is governed by that record instead.",
    questions: [
      {
        resourceType: "note",
        action: "create",
        title: "Create notes",
        description:
          "Add notes that belong to the workspace rather than to a record. Adding one to a record needs access to that record instead.",
      },
    ],
  },
  {
    id: "member",
    label: "Members",
    subtitle:
      "Who can change the roster — invite people, deactivate them, remove them. Seeing who is in the workspace is open to everyone.",
    questions: [
      {
        resourceType: "member",
        action: "configure",
        title: "Manage members",
        description:
          "Add people to the workspace, deactivate them, and remove them entirely. Reading the member list is not gated.",
      },
    ],
  },
  {
    id: "org",
    label: "Organisation",
    subtitle:
      "Who can change workspace-wide settings: its name and logo, labels, task statuses and priorities, integrations.",
    questions: [
      {
        resourceType: "org",
        action: "configure",
        title: "Configure the organisation",
        description:
          "Change the workspace's own settings — name, logo, labels, task statuses, integrations. The last grant of this cannot be removed: something has to be able to administer the workspace.",
      },
    ],
  },
  {
    id: "role",
    label: "Roles & permissions",
    subtitle:
      "Who can edit this screen — create roles, change their rules, and decide who holds them. Role names are readable by everyone.",
    questions: [
      {
        resourceType: "role",
        action: "configure",
        title: "Manage roles and permissions",
        description:
          "Create and edit roles, change what they grant, and assign them. Anyone can see role NAMES on the members page; only this grants changing them.",
      },
    ],
  },
]

/** Every `(resourceType, scopeBy)` shape a pane writes as a unit. Derived, so a
 *  column added above cannot be left out of the save. */
export const groupsOf = (pane: Pane): ReadonlyArray<Group> => {
  const seen = new Map<string, Group>()
  for (const q of pane.questions) {
    if (!seen.has(q.resourceType)) seen.set(q.resourceType, { resourceType: q.resourceType })
  }
  for (const c of pane.table?.columns ?? []) {
    const scopeBy = pane.table?.scopeBy?.[c.resourceType]
    // A type appearing as both a question and a column shares one group, and the
    // column's scope wins — the question is a blanket answer, which is the same
    // shape either way.
    seen.set(c.resourceType, { resourceType: c.resourceType, scopeBy })
  }
  return [...seen.values()]
}

/** Everything a pane can answer — questions and columns, in one list, which is what
 *  the fold needs to know which actions it manages. */
export const answerableOf = (pane: Pane): ReadonlyArray<Answerable> => [
  ...pane.questions.map((q) => ({ resourceType: q.resourceType, action: q.action })),
  ...(pane.table?.columns ?? []).flatMap((c) => [
    { resourceType: c.resourceType, action: c.action },
    // A paired answer is answerable even though it has no column of its own: the fold
    // must read it into the draft and write it back, or a save would delete it as an
    // action the pane "does not render".
    ...(c.also ?? []),
  ]),
]
