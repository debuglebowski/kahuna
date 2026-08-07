import { useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button, Callout, Card, InfoHint, Spinner } from "../../components/ui"
import { type CellState, type MatrixItem, StateGroup } from "./PermissionMatrix"

/**
 * PROTOTYPE — Concepts and Records as ONE pane, wired to nothing.
 *
 * ── WHY THEY MERGE ───────────────────────────────────────────────────────────
 *
 * The two panes already have the same rows. The Records grid is `scopeBy:
 * "concept"` — every row in it IS a concept, and the cell means "the records
 * inside this one". So the reader holds two tables of thirteen identical rows and
 * has to remember which governs the type and which its contents. One table with
 * grouped columns says the same thing once.
 *
 * The merge also loses less than it looks. `concept`/`view` already implies
 * `recordsByDefault: true` (`visibility.ts`), so the two view columns could never
 * express four independent answers — the only combination that disappears is
 * "the type is in the nav but has no rows", which is a strange thing to protect.
 *
 * What must survive: concept-view SILENT plus a per-record grant leaves the
 * concept reachable with `recordsByDefault: false`. That is how a personal role's
 * grant on one record works, and it is not edited from this table in either
 * design.
 *
 * ── FAKE ALL THE WAY DOWN ────────────────────────────────────────────────────
 *
 * The real `PermissionMatrix` is not used here: it renders one `resourceType`
 * per instance, and this table mixes two — `record` in the first group, `concept`
 * in the second. Nothing on this pane saves.
 *
 * `record`/`edit` and `record`/`create` have no gate in the engine YET —
 * `assertRecordWritable` is concept-visible plus record-readable, so read implies
 * write. That is a thing to build, not a caveat to render: the columns are drawn
 * exactly like the ones that are live, because the layout is what this pane is
 * for and a table that hedges about half its columns cannot be judged as one.
 * `assertRecordWritable` is the single choke point when it does get written.
 */

/** A blanket question: an answer with no row to sit in. */
interface Question {
  readonly id: string
  readonly title: string
  readonly description: string
}

/**
 * The two creates, which cannot be columns.
 *
 * `createConcept` asks `assertAllowed("create", {type: "concept"})` — an
 * UNTARGETED resource, because the thing does not exist when the answer is
 * needed — and `coversResource` only matches rules with a null `resourceId`. A
 * blanket rule is the only shape that can grant it.
 *
 * Records are the open question. Creation there is read-gated only today, so if
 * the gate gets written it could just as well be a per-concept COLUMN ("may add
 * to Deals, not to Companies"), which is a more useful thing to be able to say
 * than one workspace-wide yes. Left as a question here because that is the
 * status quo, not because it is the answer.
 */
const QUESTIONS: ReadonlyArray<Question> = [
  {
    id: "concept:create",
    title: "Create concepts",
    description:
      "Add new types to the workspace. This one can never be per-concept — the concept doesn't exist yet when the answer is needed.",
  },
  {
    id: "record:create",
    title: "Create records",
    description:
      "Add entries to the concepts this role can reach. Blanket for now; a per-concept column would say more.",
  },
]

/** One column. `group` is the header it sits under — which is what lets the
 *  labels stay one word each without "View" and "Configure" reading as if they
 *  were about the same thing. */
interface Column {
  readonly id: string
  readonly group: string
  readonly label: string
  readonly hint: string
}

/**
 * THE MERGED COLUMN SET.
 *
 * Three columns about the contents, two about the type, on one row per concept.
 * That asymmetry is the actual cost of merging, and grouped headers are the
 * cheapest honest way to carry it — the alternative is repeating the noun in
 * every label ("View records", "Archive concept"), which reads fine once and
 * turns the header into a paragraph.
 */
const COLUMNS: ReadonlyArray<Column> = [
  {
    id: "record:view",
    group: "Records",
    label: "View",
    hint: "See the entries inside this concept. Denying this leaves the concept itself reachable but empty.",
  },
  {
    id: "record:edit",
    group: "Records",
    label: "Edit",
    hint: "Change the entries inside this concept, without being able to change how the concept is set up.",
  },
  {
    id: "concept:configure",
    group: "The concept",
    label: "Configure",
    hint: "See and change how the concept is set up: its name, its fields, its title field, its settings.",
  },
  {
    id: "concept:archive",
    group: "The concept",
    label: "Archive",
    hint: "Hide the concept without destroying it. Reversible.",
  },
  {
    id: "concept:delete",
    group: "The concept",
    label: "Delete",
    hint: "Destroy the concept permanently, along with every record in it.",
  },
]

/**
 * What each GROUP means.
 *
 * The one distinction this whole merge rests on — records versus the type they
 * live in — so it gets stated rather than left to be inferred from two words. A
 * reader who gets this pair the wrong way round grants the opposite of what they
 * meant, and nothing on the screen would tell them.
 */
const GROUP_HINTS: Record<string, string> = {
  Records:
    "The entries stored under this concept. Nothing here touches how the concept itself is set up.",
  "The concept":
    "The type itself — how it is set up, and whether it exists at all. Separate from the records inside it, so a role can be trusted with the data and kept away from the schema.",
}

/** Column groups in order, with how many columns each spans — derived, so adding
 *  a column to {@link COLUMNS} cannot leave the spanning header row lying. */
const GROUPS: ReadonlyArray<{ label: string; span: number }> = COLUMNS.reduce<
  Array<{ label: string; span: number }>
>((acc, c) => {
  const last = acc[acc.length - 1]
  if (last && last.label === c.group) last.span += 1
  else acc.push({ label: c.group, span: 1 })
  return acc
}, [])

/**
 * Does this column open a new group? Every cell in that position takes a left
 * border, in EVERY row.
 *
 * A grouping that exists only in the header is a claim the table then stops
 * making: three rows down, the reader is looking at five evenly-spaced controls
 * and has to count back up to work out where "Records" stopped. The rules run the
 * full height so the two groups are two blocks wherever the eye happens to land —
 * which is the entire argument for merging the panes rather than a decoration on
 * top of it.
 *
 * Derived from {@link COLUMNS}, like the spans, so the borders cannot end up
 * describing a grouping the header no longer has.
 */
const OPENS_GROUP: ReadonlyArray<boolean> = COLUMNS.map(
  (c, i) => i === 0 || COLUMNS[i - 1]?.group !== c.group,
)

/** The rule itself, so header and body cells cannot drift apart. */
const groupEdge = (i: number) => (OPENS_GROUP[i] ? "border-l" : "")

/** A row of the table: one concept, or the single blanket row. */
interface Row {
  readonly id: string
  readonly label: string
}

/**
 * The permission table. ONE component for both shapes — Granularity only changes
 * what goes in `rows`.
 *
 * That is the claim being tested, so it had better be true of the code as well:
 * two differently-built tables would have drifted, and the switch would have felt
 * like navigating somewhere rather than like widening the same question.
 */
function PermissionTable({
  itemsLabel,
  rows,
  answer,
  onAnswer,
}: {
  itemsLabel: string
  rows: ReadonlyArray<Row>
  answer: (key: string) => CellState
  onAnswer: (key: string, next: CellState) => void
}) {
  return (
    // `table-fixed` + a colgroup, rather than a width class on the header cell.
    // Auto layout treats a width as a suggestion and hands out spare space in
    // proportion to content, so the name column grew or shrank with whatever
    // concepts the org happened to have — and the controls landed somewhere
    // different on every role. Fixed layout pins the first column and splits the
    // rest evenly, so the five groups of tri-states sit at the same x on every
    // row, in both shapes of the table.
    <Table className="table-fixed">
      <colgroup>
        <col className="w-64" />
        {COLUMNS.map((c) => (
          <col key={c.id} />
        ))}
      </colgroup>
      <TableHeader>
        {/* THE GROUP ROW. Without it, "View" and "Configure" sit side by side as
            peers when one is about the rows inside the concept and the other about
            the concept itself — the exact confusion the two separate panes used to
            cause, rebuilt inside one header.

            TINTED BANDS, and the strongest text in the table. This row outranks
            the column heads under it, so it cannot also be quieter than them —
            drawn as a faint caption it read as decoration and the eye went
            straight past to "VIEW / EDIT / CONFIGURE" as five peers, which is
            precisely the reading the merge has to prevent. The first cell stays
            untinted so the band starts where the groups do — which only works
            while the band sits flush against the divider above it. */}
        <TableRow className="hover:bg-transparent">
          <TableHead className="border-b-0" />
          {GROUPS.map((g) => (
            <TableHead
              key={g.label}
              colSpan={g.span}
              className="border-b-0 border-l bg-muted/60 py-1.5 text-center text-xs font-semibold uppercase tracking-wider text-foreground/80"
            >
              <span className="inline-flex items-center gap-1.5">
                {g.label}
                <InfoHint text={GROUP_HINTS[g.label]} label={`${g.label} — more info`} />
              </span>
            </TableHead>
          ))}
        </TableRow>
        {/* The column heads stay MUTED. Two rows of the same weight would make the
            reader work out which one governs which, and the answer is already in
            the spans and the rules running down between them. */}
        <TableRow className="border-b hover:bg-transparent">
          <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {itemsLabel}
          </TableHead>
          {COLUMNS.map((c, i) => (
            <TableHead
              key={c.id}
              className={`text-center text-xs font-medium uppercase tracking-wider text-muted-foreground ${groupEdge(i)}`}
            >
              <span className="inline-flex items-center gap-1.5">
                {c.label}
                <InfoHint text={c.hint} label={`${c.label} — more info`} />
              </span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id} className="hover:bg-transparent">
            {/* `truncate` + `title`: the column no longer grows to fit, so a long
                concept name has to be clipped rather than allowed to push the
                controls out of line. The full name stays reachable on hover. */}
            <TableCell className="truncate font-medium text-foreground" title={r.label}>
              {r.label}
            </TableCell>
            {COLUMNS.map((c, i) => {
              const k = `${r.id}:${c.id}`
              return (
                <TableCell key={c.id} className={`text-center ${groupEdge(i)}`}>
                  <div className="flex justify-center">
                    <StateGroup
                      state={answer(k)}
                      onSelect={(next) => onAnswer(k, next)}
                      describe={(s) =>
                        `${s.label} ${c.group.toLowerCase()} ${c.label.toLowerCase()} on ${r.label}`
                      }
                    />
                  </div>
                </TableCell>
              )
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/**
 * One question, in its own card: what it is on the left, the answer on the right.
 *
 * A CARD EACH, not hairlines down one list. The list was cheaper in chrome, but
 * it made every question look like an item in a settings menu of equal weight —
 * and one of these is not an item at all. Granularity OWNS the table, and a card
 * is the only container that can show that: the question sits at the top, a
 * divider under it, and the thing it reshapes inside the same border. Read as a
 * list, the table was just the next thing down the page from a control that
 * happened to be near it.
 *
 * The description is a PARAGRAPH rather than a tooltip, here and only here. A
 * question has the width for one, and these are the answers a reader is least
 * equipped to guess at: the two creates look like they should be columns, and
 * Granularity is not a permission. The column descriptions have no such room and
 * settle for a hint.
 */
function Section({
  title,
  description,
  control,
  children,
}: {
  title: string
  description: string
  control: React.ReactNode
  /** What this question governs, rendered under a divider inside the same card.
   *  Full-bleed: it meets the card's edges and the outer CELLS carry the inset,
   *  so a table's header row starts where the question's title does. */
  children?: React.ReactNode
}) {
  return (
    <Card>
      {/* The extra room goes ABOVE the divider, not below it. The divider IS the
          table's top edge, so padding on the far side of it opens a gap between
          the table and its own border and leaves the header band floating. What
          needed separating was the question from the table — so the question
          gets the space. */}
      <div
        className={`flex items-start justify-between gap-8 px-6 pt-4 ${children ? "pb-12" : "pb-4"}`}
      >
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-foreground">{title}</h4>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="shrink-0 pt-0.5">{control}</div>
      </div>
      {children ? (
        <div className="border-t [&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6">
          {children}
        </div>
      ) : null}
    </Card>
  )
}

/**
 * Two segments, built to match {@link StateGroup} exactly — same border, same
 * height, same rhythm — because it sits in the same column as the tri-states and
 * a differently-shaped control there reads as a different KIND of answer.
 *
 * NAMED OPTIONS, not Yes/No. "Yes" only means something once you have read the
 * label and worked out what agreeing to it does; "All" and "Individual" name the
 * two shapes the table takes, and still read correctly from the answer alone with
 * the question forgotten.
 *
 * Neutral fill, not the tri-state's green/red: this is not a permission. It picks
 * how the next question is asked, and colour here would say granting.
 */
function Segmented({
  value,
  onChange,
  options,
  label,
}: {
  value: boolean
  onChange: (next: boolean) => void
  /** `[whenFalse, whenTrue]`, in the order they render. */
  options: readonly [string, string]
  label: string
}) {
  return (
    <fieldset
      aria-label={label}
      className="inline-flex overflow-hidden rounded-md border border-border/70 bg-background"
    >
      {([false, true] as const).map((v) => (
        <button
          key={options[v ? 1 : 0]}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`flex h-6 items-center justify-center px-3 text-xs font-medium border-border/70 transition not-last:border-r ${
            value === v
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground/50 hover:bg-accent/50 hover:text-foreground"
          }`}
        >
          {options[v ? 1 : 0]}
        </button>
      ))}
    </fieldset>
  )
}

/**
 * The unsaved-changes bar.
 *
 * `sticky`, not `fixed`: it belongs to the pane, so it rides the pane's scroll
 * container and cannot end up floating over a different tab. It is also IN FLOW
 * at the end of the content, which keeps it from covering the last row of the
 * table once you scroll to the bottom.
 *
 * It appears rather than sitting there greyed out. A permanently-visible Save
 * button is a control the reader has to check the state of; one that shows up the
 * moment there is something to save is a statement they can read at a glance.
 */
function SaveBar({ onSave, onReset }: { onSave: () => void; onReset: () => void }) {
  return (
    // `bottom-0`, not a floating inset: the bar belongs to the bottom EDGE of the
    // pane, and a gap under it left a strip of scrolling content showing beneath
    // a bar that is supposed to be the last thing on the screen.
    //
    // `shadow-lift` inverts with the palette (see `--lift` in index.css) — a black
    // shadow is invisible on the dark theme, which is exactly where a bar floating
    // over content most needs to be told apart from it.
    <div className="sticky bottom-0 z-10 flex animate-in items-center gap-3 rounded-xl border bg-popover px-4 py-2.5 text-popover-foreground shadow-lift duration-200 fade-in slide-in-from-bottom-2">
      <span className="flex-1 text-sm font-medium">You have unsaved changes</span>
      <Button variant="ghost" size="sm" onClick={onReset}>
        Reset
      </Button>
      <Button size="sm" onClick={onSave}>
        Save changes
      </Button>
    </div>
  )
}

/** Do two answer maps say the same thing? An absent key and an explicit
 *  `"inherit"` are the SAME answer — without that, setting a cell to Allow and
 *  back again would leave the bar up offering to save nothing. */
const sameAnswers = (a: Map<string, CellState>, b: Map<string, CellState>): boolean => {
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(k) ?? "inherit") !== (b.get(k) ?? "inherit")) return false
  }
  return true
}

/** The blanket row's id, in the same key space as a concept's uuid — which no
 *  uuid can collide with. */
const ALL_ROW = "__all__"

export function PermissionsPrototype({
  items,
  itemsLabel,
  loading,
}: {
  items: ReadonlyArray<MatrixItem>
  itemsLabel: string
  loading?: boolean
}) {
  /** Local and throwaway. Every answer starts at Inherit, which is what a role
   *  that has said nothing actually holds. */
  const [answers, setAnswers] = useState<Map<string, CellState>>(new Map())
  /** What a save would have written, standing in for the server. Comparing
   *  against THIS rather than against "is anything set" is what makes Reset mean
   *  "back to the last save" instead of "back to blank". */
  const [saved, setSaved] = useState<Map<string, CellState>>(new Map())
  /** ALL by default, and that is the argument: per-concept exceptions are the
   *  rare case, so the reader should have to ask for the long table rather than
   *  be handed one and left to work out that every row can stay untouched. */
  const [individual, setIndividual] = useState(false)

  const answer = (k: string) => answers.get(k) ?? "inherit"
  const setAnswer = (k: string, next: CellState) => setAnswers((cur) => new Map(cur).set(k, next))

  const dirty = !sameAnswers(answers, saved)
  const save = () => setSaved(new Map(answers))
  const reset = () => setAnswers(new Map(saved))

  const rows: ReadonlyArray<Row> = individual
    ? items.map((i) => ({ id: i.id, label: i.name }))
    : [{ id: ALL_ROW, label: `All ${itemsLabel.toLowerCase()}s` }]

  return (
    <div className="space-y-4">
      <Callout tone="blue" title="Prototype — nothing here saves">
        A layout to look at, not a working editor. Every control on this pane is local state.
      </Callout>

      {/* The answers that are NOT columns. One card each — see `Section`. */}
      {QUESTIONS.map((q) => (
        <Section
          key={q.id}
          title={q.title}
          description={q.description}
          control={
            <StateGroup
              state={answer(q.id)}
              onSelect={(next) => setAnswer(q.id, next)}
              describe={(s) => `${s.label} — ${q.title}`}
            />
          }
        />
      ))}

      {/* GRANULARITY OWNS THE TABLE, so they share a card. ONE table, two shapes:
          same columns, same controls, same border — the question at the top adds
          and removes ROWS and changes nothing else. Per-item permissions are not
          a different feature; they are the same answers asked once per item, and
          an org that never needs that should never have to look at the long
          version. Split across two cards, that read as a setting and then,
          separately, a table. */}
      <Section
        title="Granularity"
        description={
          individual
            ? `Individual — one row per ${itemsLabel.toLowerCase()}, so a single one can differ from the rest.`
            : `All — one row, covering every ${itemsLabel.toLowerCase()} including ones added later.`
        }
        control={
          <Segmented
            value={individual}
            onChange={setIndividual}
            options={["All", "Individual"]}
            label="Granularity"
          />
        }
      >
        {loading ? (
          <div className="px-6 py-8">
            <Spinner />
          </div>
        ) : (
          <PermissionTable
            itemsLabel={itemsLabel}
            rows={rows}
            answer={answer}
            onAnswer={setAnswer}
          />
        )}
      </Section>

      {dirty ? <SaveBar onSave={save} onReset={reset} /> : null}
    </div>
  )
}
