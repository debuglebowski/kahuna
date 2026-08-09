import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Info } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Badge, Button, Callout, Card, InfoHint, Spinner } from "../../../components/ui"
import { api } from "../../../lib/api"
import { Feedback } from "../parts"
import { ALL_ROW, type FoldRule, key, type Passthrough, readAnswers, writeGroups } from "./fold"
import { answerableOf, type Column, GROUP_HINTS, groupsOf, type Pane } from "./panes"
import { type CellState, StateGroup } from "./StateGroup"

/**
 * ONE PANE, EVERY TAB.
 *
 * A short list of question CARDS for answers that have no row, then ONE TABLE whose
 * shape — a single blanket row, or a row per item — is chosen by a Granularity
 * control living in the same card as the table it reshapes.
 *
 * ── WHY NOT A GRID ───────────────────────────────────────────────────────────
 *
 * The pane this replaced was a grid per resource type: every action a column, every
 * concept a row, and the reader handed a 13×4 field of identical controls before
 * being told what a single one of them means. Most orgs only ever want one answer
 * per action ("can this role delete concepts? no"), and the grid made that the hard
 * case — thirteen identical clicks — while making the rare case the default frame.
 *
 * Granularity inverts that. It changes ROWS and nothing else: same columns, same
 * controls, same card. Per-item permissions are not a different feature, they are
 * the same answers asked once per item, and an org that never needs that should
 * never have to look at the long version.
 *
 * ── WHY CONCEPTS AND RECORDS SHARE A PANE ────────────────────────────────────
 *
 * They always had the same rows. The records half is `scopeBy: "concept"` — every
 * row in it IS a concept, and the cell means "the records inside this one" — so two
 * tabs asked the reader to hold two tables of identical rows and remember which
 * governed the type and which its contents. Grouped column headers say it once.
 */

/** A row of the table: one resource, or the single blanket row. */
interface Row {
  readonly id: string
  readonly label: string
}

/**
 * One question, in its own card: what it is on the left, the answer on the right.
 *
 * A CARD EACH, not hairlines down one list. Granularity OWNS the table, and a card
 * is the only container that can show that — the question at the top, a divider
 * under it, and the thing it reshapes inside the same border. Read as a flat list,
 * the table was just the next thing down the page from a control that happened to
 * be near it.
 *
 * The description is a PARAGRAPH rather than a tooltip, here and only here. A
 * question has the width for one, and these are the answers a reader is least
 * equipped to guess at. Column descriptions have no such room and settle for a hint.
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
  /** What this question governs, under a divider inside the same card. Full-bleed:
   *  it meets the card's edges and the outer CELLS carry the inset, so a table's
   *  header row starts where the question's title does. */
  children?: React.ReactNode
}) {
  return (
    <Card>
      {/* The extra room goes ABOVE the divider. The divider IS the table's top edge,
          so padding on the far side of it opens a gap between the table and its own
          border and leaves the header band floating. */}
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
 * height, same rhythm — because it sits in the same column as the tri-states and a
 * differently-shaped control there reads as a different KIND of answer.
 *
 * NAMED OPTIONS, not Yes/No. "Yes" only means something once you have read the label
 * and worked out what agreeing to it does; "All" and "Individual" name the two shapes
 * the table takes, and still read correctly from the answer alone.
 *
 * Neutral fill, not the tri-state's green/red: this is not a permission. It picks how
 * the next question is asked, and colour here would say granting.
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
 * container and cannot float over a different tab. It is also IN FLOW at the end of
 * the content, which keeps it from covering the last row once you scroll down.
 *
 * It appears rather than sitting there greyed out. A permanently-visible Save button
 * is a control the reader has to check the state of; one that shows up the moment
 * there is something to save is a statement they can read at a glance.
 */
function SaveBar({
  saving,
  onSave,
  onReset,
  error,
}: {
  saving: boolean
  onSave: () => void
  onReset: () => void
  error?: string
}) {
  return (
    // `shadow-lift` inverts with the palette (see `--lift` in index.css) — a black
    // shadow is invisible on the dark theme, which is exactly where a bar floating
    // over content most needs to be told apart from it.
    <div className="sticky bottom-0 z-10 flex animate-in items-center gap-3 rounded-xl border bg-popover px-4 py-2.5 text-popover-foreground shadow-lift duration-200 fade-in slide-in-from-bottom-2">
      <span className="flex-1 text-sm font-medium">
        {error ? <Feedback error={error} /> : "You have unsaved changes"}
      </span>
      <Button variant="ghost" size="sm" onClick={onReset} disabled={saving}>
        Reset
      </Button>
      <Button size="sm" onClick={onSave} disabled={saving}>
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </div>
  )
}

export function PermissionPane({
  pane,
  roleId,
  rules,
  items,
  loading,
  parentRules,
  parentLabel,
}: {
  pane: Pane
  roleId: string
  rules: ReadonlyArray<FoldRule>
  /** The pane's rows. Empty for a cards-only pane. */
  items: ReadonlyArray<{ readonly id: string; readonly name: string }>
  loading?: boolean
  /** The `based on` parent's rules (P6): an Inherit answer the PARENT decides gets a
   *  badge naming what it resolves to, one level up. */
  parentRules?: ReadonlyArray<FoldRule>
  parentLabel?: string
}) {
  const qc = useQueryClient()
  const groups = useMemo(() => groupsOf(pane), [pane])
  const answerable = useMemo(() => answerableOf(pane), [pane])
  const columns = pane.table?.columns ?? []

  const server = useMemo(() => readAnswers(rules, groups, answerable), [rules, groups, answerable])
  const [draft, setDraft] = useState<ReadonlyMap<string, CellState>>(server.answers)
  const [dirty, setDirty] = useState(false)
  /** OFF by default, and that is the argument: per-item exceptions are the rare
   *  case, so the reader should have to ask for the long table rather than be handed
   *  one and left to work out that every row can stay untouched. */
  const [individual, setIndividual] = useState(false)

  // Re-seed from the server whenever the rules change — and NOT while dirty, or a
  // background refetch would silently discard edits mid-flow.
  useEffect(() => {
    if (dirty) return
    setDraft(server.answers)
  }, [server.answers, dirty])

  const save = useMutation({
    mutationFn: () =>
      api.setRoleRules({
        roleId,
        groups: writeGroups(
          draft,
          server.passthrough as Passthrough,
          groups,
          answerable,
          items.map((i) => i.id),
        ),
      }),
    onSuccess: () => {
      setDirty(false)
      void qc.invalidateQueries({ queryKey: ["rules", roleId] })
    },
  })

  const answer = (rowId: string, resourceType: string, action: string) =>
    draft.get(key(rowId, resourceType, action)) ?? "inherit"
  const setAnswer = (rowId: string, resourceType: string, action: string, next: CellState) => {
    setDraft((cur) => new Map(cur).set(key(rowId, resourceType, action), next))
    setDirty(true)
  }
  /** One column's control, which may stand for more than one answer (`Column.also`).
   *  Written in a single state update so a paired write cannot half-apply. */
  const setColumn = (rowId: string, c: Column, next: CellState) => {
    setDraft((cur) => {
      const m = new Map(cur)
      for (const t of [{ resourceType: c.resourceType, action: c.action }, ...(c.also ?? [])]) {
        m.set(key(rowId, t.resourceType, t.action), next)
      }
      return m
    })
    setDirty(true)
  }

  /** What the `based on` PARENT resolves for an answer this role stays silent on —
   *  named, not folded into the draft: this role's own Inherit is still the truth for
   *  what THIS role writes, the parent's value is context for the reader. */
  const inherited = useMemo(
    () => (parentRules ? readAnswers(parentRules, groups, answerable).answers : null),
    [parentRules, groups, answerable],
  )

  const rows: ReadonlyArray<Row> = individual
    ? items.map((i) => ({ id: i.id, label: i.name }))
    : [{ id: ALL_ROW, label: `All ${(pane.table?.itemsLabel ?? "item").toLowerCase()}s` }]

  /** Column groups in order, with how many columns each spans — derived, so adding a
   *  column cannot leave the spanning header row lying. */
  const bands = columns.reduce<Array<{ label: string; span: number }>>((acc, c) => {
    const last = acc[acc.length - 1]
    if (last && last.label === c.group) last.span += 1
    else acc.push({ label: c.group, span: 1 })
    return acc
  }, [])
  /** One group is not a grouping. Dashboards, views and automations have a single
   *  band, so the header row and its vertical rules collapse away rather than
   *  drawing a box around the only thing there is. */
  const banded = bands.length > 1
  const opensBand = (i: number) =>
    banded && (i === 0 || columns[i - 1]?.group !== columns[i]?.group)

  const table = (
    // `table-fixed` + a colgroup rather than a width class: auto layout treats a
    // width as a suggestion and hands out spare space in proportion to content, so
    // the name column grew and shrank with whatever the org happened to have, and the
    // controls landed somewhere different on every role.
    <Table className="table-fixed">
      <colgroup>
        <col className="w-64" />
        {columns.map((c) => (
          <col key={`${c.resourceType}:${c.action}`} />
        ))}
      </colgroup>
      <TableHeader>
        {banded ? (
          // TINTED BANDS, and the strongest text in the table. This row outranks the
          // column heads under it, so it cannot also be quieter than them — drawn as
          // a faint caption it read as decoration and the eye went straight past to
          // the columns as peers, which is the reading the merge exists to prevent.
          <TableRow className="hover:bg-transparent">
            <TableHead className="border-b-0" />
            {bands.map((b) => (
              <TableHead
                key={b.label}
                colSpan={b.span}
                className="border-b-0 border-l bg-muted/60 py-1.5 text-center text-xs font-semibold uppercase tracking-wider text-foreground/80"
              >
                <span className="inline-flex items-center gap-1.5">
                  {b.label}
                  {GROUP_HINTS[b.label] ? (
                    <InfoHint text={GROUP_HINTS[b.label]} label={`${b.label} — more info`} />
                  ) : null}
                </span>
              </TableHead>
            ))}
          </TableRow>
        ) : null}
        <TableRow className="border-b hover:bg-transparent">
          <TableHead className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {pane.table?.itemsLabel}
          </TableHead>
          {columns.map((c, i) => (
            <TableHead
              key={`${c.resourceType}:${c.action}`}
              className={`text-center text-xs font-medium uppercase tracking-wider text-muted-foreground ${opensBand(i) ? "border-l" : ""}`}
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
                name is clipped rather than allowed to push the controls out of line. */}
            <TableCell className="truncate font-medium text-foreground" title={r.label}>
              {r.label}
            </TableCell>
            {columns.map((c, i) => {
              const state = answer(r.id, c.resourceType, c.action)
              const from =
                state === "inherit"
                  ? inherited?.get(key(r.id, c.resourceType, c.action))
                  : undefined
              return (
                <TableCell
                  key={`${c.resourceType}:${c.action}`}
                  className={`text-center ${opensBand(i) ? "border-l" : ""}`}
                >
                  <div className="flex items-center justify-center gap-1.5">
                    <StateGroup
                      state={state}
                      onSelect={(next) => setColumn(r.id, c, next)}
                      describe={(s) => `${s.label} ${c.label.toLowerCase()} on ${r.label}`}
                    />
                    {from && from !== "inherit" ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Badge tone={from === "allow" ? "green" : "red"}>
                              {parentLabel ?? "parent"}
                            </Badge>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          Inherited from {parentLabel ?? "its parent role"}:{" "}
                          {from === "allow" ? "Allow" : "Deny"}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                </TableCell>
              )
            })}
          </TableRow>
        ))}
        {individual && items.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell
              colSpan={columns.length + 1}
              className="py-6 text-center text-sm text-muted-foreground"
            >
              None yet — switch back to All to answer for any made later.
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  )

  return (
    <div className="space-y-4">
      {pane.caveat ? (
        <Callout tone="blue" icon={<Info size={14} />} title="Worth knowing">
          {pane.caveat}
        </Callout>
      ) : null}

      {pane.questions.map((q) => (
        <Section
          key={`${q.resourceType}:${q.action}`}
          title={q.title}
          description={q.description}
          control={
            <StateGroup
              state={answer(ALL_ROW, q.resourceType, q.action)}
              onSelect={(next) => setAnswer(ALL_ROW, q.resourceType, q.action, next)}
              describe={(s) => `${s.label} — ${q.title}`}
            />
          }
        />
      ))}

      {pane.table ? (
        <Section
          title="Granularity"
          description={
            individual
              ? `Individual — one row per ${pane.table.itemsLabel.toLowerCase()}, so a single one can differ from the rest.`
              : `All — one row, covering every ${pane.table.itemsLabel.toLowerCase()} including ones added later.`
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
            table
          )}
        </Section>
      ) : null}

      {dirty ? (
        <SaveBar
          saving={save.isPending}
          onSave={() => save.mutate()}
          onReset={() => {
            setDirty(false)
            setDraft(server.answers)
            save.reset()
          }}
          error={save.error ? (save.error as Error).message : undefined}
        />
      ) : null}
    </div>
  )
}
