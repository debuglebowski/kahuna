import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery } from "@tanstack/react-query"
import { ChevronDown, FlaskConical, History, Plus, SlidersHorizontal, X } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { ConditionList, useFields } from "../../components/ConditionList"
import { usePageChrome } from "../../components/Layout"
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Field,
  IconButton,
  InfoHint,
  Input,
  Spinner,
  TabBar,
  TabBarItem,
} from "../../components/ui"
import {
  type AutomationAction,
  type AutomationTrigger,
  api,
  type SidebarCondition,
} from "../../lib/api"
import {
  automationRunsFor,
  automationsCollection,
  conceptsCollection,
  KEY,
  useRegisterCollection,
} from "../../lib/collections"
import { useUnsavedGuard } from "../../lib/useUnsavedGuard"
import {
  ACTION_OPTIONS,
  describeAction,
  describeTrigger,
  emptyAction,
  TEMPLATE_TOKENS,
  TRIGGER_OPTIONS,
} from "./automationText"
import { DangerZone, Feedback } from "./parts"

const NONE = "__none"

/**
 * `/automations/:id` — the full-page editor, in two tabs.
 *
 * **Config** is what the automation WILL do: three stacked blocks reading as the
 * sentence it is — When / If / Then — plus Test (a dry run that writes nothing)
 * and the danger zone. **History** is what it HAS done: every run, including the
 * ones that decided to do nothing, which is how "why didn't it fire?" gets
 * answered. Each tab states its purpose in a line beneath the bar, because
 * "History" on its own reads like a changelog of the rule rather than of runs.
 *
 * Config edits a local draft; Save persists; a discard confirm fires on any nav
 * away while dirty (the settings-editor convention). The save bar only shows on
 * Config — there is nothing to save on History.
 */
export function AutomationEditor({ id, admin }: { id: string; admin: boolean }) {
  usePageChrome({ fillHeight: true })
  const navigate = useNavigate()
  useRegisterCollection(KEY.automations, automationsCollection)
  const runs = automationRunsFor(id)
  useRegisterCollection(KEY.automationRuns(id), runs)

  const { data: rows = [], isLoading } = useLiveQuery((q) => q.from({ a: automationsCollection }))
  const saved = rows.find((a) => a.id === id)
  // Badge on the History tab, so the count is visible without switching to it.
  const { data: runRows = [] } = useLiveQuery((q) => q.from({ r: runs }))
  const runCount = runRows.length

  // The draft. Seeded once the row arrives; `seeded` guards against a live-sync
  // refetch clobbering in-progress edits.
  const [seeded, setSeeded] = useState(false)
  const [name, setName] = useState("")
  const [trigger, setTrigger] = useState<AutomationTrigger>({ kind: "record.changed" })
  const [conditions, setConditions] = useState<readonly SidebarCondition[]>([])
  const [match, setMatch] = useState<"all" | "any">("all")
  const [actions, setActions] = useState<readonly AutomationAction[]>([])
  const [dirty, setDirty] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [tab, setTab] = useState("config")
  const { blocker, bypass } = useUnsavedGuard(dirty)

  if (saved && !seeded) {
    setSeeded(true)
    setName(saved.name)
    setTrigger(saved.trigger)
    setConditions(saved.conditions)
    setMatch(saved.match)
    setActions(saved.actions)
  }

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v)
      setDirty(true)
    }

  const save = useMutation({
    mutationFn: () =>
      api.updateAutomation({
        id,
        name: name.trim() || "Untitled automation",
        trigger,
        conditions,
        match,
        actions,
      }),
    onSuccess: async () => {
      await automationsCollection.utils.refetch()
      setDirty(false)
    },
  })
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateAutomation({ id, enabled }),
    onSuccess: () => automationsCollection.utils.refetch(),
  })
  const archive = useMutation({
    mutationFn: () => api.archiveAutomation(id),
    onSuccess: async () => {
      await automationsCollection.utils.refetch()
      bypass()
      navigate("/automations")
    },
  })
  const restore = useMutation({
    mutationFn: () => api.restoreAutomation(id),
    onSuccess: () => automationsCollection.utils.refetch(),
  })
  const del = useMutation({
    mutationFn: () => api.deleteAutomation(id),
    onSuccess: async () => {
      await automationsCollection.utils.refetch()
      bypass()
      navigate("/automations")
    },
  })
  const test = useMutation({ mutationFn: () => api.testAutomation(id) })

  if (isLoading) return <Spinner />
  if (!saved) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">This automation no longer exists.</p>
        <Button variant="outline" onClick={() => navigate("/automations")}>
          Back to automations
        </Button>
      </div>
    )
  }

  const conceptId = trigger.conceptId ?? ""
  const readOnly = !admin

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 pb-3 text-base font-medium text-foreground">
        <button
          type="button"
          onClick={() => navigate("/automations")}
          className="truncate text-muted-foreground hover:text-foreground"
        >
          Automations
        </button>
        <span className="text-muted-foreground/50">/</span>
        <span className="truncate">{name.trim() || "Untitled automation"}</span>
        {saved.enabled ? <Badge tone="green">on</Badge> : <Badge tone="gray">off</Badge>}
        {saved.pausedReason && <Badge tone="red">paused: {saved.pausedReason}</Badge>}
      </div>

      {/* Config = what it WILL do; History = what it HAS done. The two questions
          people actually arrive with, and the subtitle under each tab says so —
          "History" alone reads like a changelog of the rule itself. */}
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0 overflow-hidden">
        <TabBar>
          <TabBarItem value="config" icon={<SlidersHorizontal size={16} />}>
            Config
          </TabBarItem>
          <TabBarItem value="history" icon={<History size={16} />}>
            History
            {runCount > 0 && <span className="ml-1.5 text-muted-foreground">{runCount}</span>}
          </TabBarItem>
        </TabBar>

        <TabsContent value="config" className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-4 pb-28">
          <p className="text-xs text-muted-foreground">
            What this automation will do the next time it runs.
          </p>
          {saved.pausedReason && (
            <Card className="border-destructive/40">
              <div className="px-4 py-3 text-sm text-foreground">
                This automation paused itself after running more than 20 times in a minute. Turning
                it back on clears the pause — check the conditions first.
              </div>
            </Card>
          )}

          <div className="flex items-start gap-3">
            <Field label="Name" className="flex-1">
              <Input
                value={name}
                onChange={(e) => edit(setName)(e.target.value)}
                placeholder="What this automation does…"
                disabled={readOnly}
              />
            </Field>
            <Field label="Enabled">
              <Select
                value={saved.enabled ? "on" : "off"}
                onValueChange={(v) => toggle.mutate(v === "on")}
                disabled={readOnly || !!saved.archivedAt}
              >
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="on">On</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {/* ── WHEN ─────────────────────────────────────────────────────────── */}
          <Card>
            <CardHeader
              title="When"
              action={<span className="text-xs text-muted-foreground">the trigger</span>}
            />
            <div className="space-y-3 px-4 py-3">
              <TriggerEditor value={trigger} onChange={edit(setTrigger)} disabled={readOnly} />
              <p className="text-xs text-muted-foreground">{describeTrigger(trigger)}</p>
            </div>
          </Card>

          {/* ── IF ───────────────────────────────────────────────────────────── */}
          <Card>
            <CardHeader
              title="If"
              action={
                <span className="text-xs text-muted-foreground">
                  optional — conditions on the record
                </span>
              }
            />
            <div className="space-y-2 px-4 py-3">
              {conceptId ? (
                <>
                  <ConditionList
                    conceptId={conceptId}
                    conditions={conditions}
                    labels={[]}
                    onChange={(next) => edit(setConditions)(next)}
                    match={match}
                    onMatchChange={(m) => edit(setMatch)(m === "any" ? "any" : "all")}
                    // Automations are the only surface with a "before" state, so
                    // they're the only one that may offer the transition ops.
                    transitions
                  />
                  <p className="text-xs text-muted-foreground">
                    <strong>changed to</strong> / <strong>changed from</strong> match a transition,
                    not a resting value — so re-saving an already-won deal won't re-fire the rule.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Pick a concept above to filter on its fields.
                </p>
              )}
            </div>
          </Card>

          {/* ── THEN ─────────────────────────────────────────────────────────── */}
          <Card>
            <CardHeader
              title="Then"
              action={<span className="text-xs text-muted-foreground">run in order</span>}
            />
            <div className="divide-y divide-border">
              {actions.length === 0 && (
                <p className="px-4 py-3 text-sm text-muted-foreground">
                  No actions yet — an automation needs at least one to save.
                </p>
              )}
              {actions.map((action, i) => (
                <ActionEditor
                  // biome-ignore lint/suspicious/noArrayIndexKey: actions are positional
                  key={i}
                  action={action}
                  conceptId={conceptId}
                  disabled={readOnly}
                  onChange={(next) => edit(setActions)(actions.map((a, j) => (j === i ? next : a)))}
                  onRemove={() => edit(setActions)(actions.filter((_, j) => j !== i))}
                />
              ))}
              {!readOnly && (
                <div className="px-4 py-3">
                  <Select
                    value=""
                    onValueChange={(k) =>
                      edit(setActions)([...actions, emptyAction(k as AutomationAction["kind"])])
                    }
                  >
                    <SelectTrigger className="w-56">
                      <span className="flex items-center gap-1.5 text-sm">
                        <Plus size={14} /> Add an action
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {ACTION_OPTIONS.map((o) => (
                        <SelectItem key={o.kind} value={o.kind}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </Card>

          {/* ── TEST ─────────────────────────────────────────────────────────── */}
          <Card>
            <CardHeader
              title="Test"
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => test.mutate()}
                  disabled={test.isPending || readOnly}
                >
                  <FlaskConical size={14} />
                  {test.isPending ? "Testing…" : "Dry run"}
                </Button>
              }
            />
            <div className="px-4 py-3">
              {test.data ? (
                <div className="space-y-2">
                  <p className="text-sm text-foreground">
                    {test.data.matched} of {test.data.scanned} records match. Nothing was written.
                  </p>
                  {test.data.note && (
                    <p className="text-xs text-muted-foreground">{test.data.note}</p>
                  )}
                  {test.data.samples.length > 0 && (
                    <ul className="space-y-0.5 text-xs text-muted-foreground">
                      {test.data.samples.map((s) => (
                        <li key={s.id} className="truncate">
                          {s.label}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Evaluates the trigger and conditions against recent records and shows what would
                  happen — writing nothing.
                </p>
              )}
              <Feedback error={test.error} />
            </div>
          </Card>

          {admin && (
            <DangerZone
              noun="automation"
              archived={!!saved.archivedAt}
              archiveHint="Stops it and hides it from the list. Its run history is kept."
              restoreHint="Brings it back — still switched off."
              onArchive={() => archive.mutate()}
              onRestore={() => restore.mutate()}
              restorePending={restore.isPending}
              restoreError={restore.error ? (restore.error as Error).message : undefined}
              onDelete={() => setConfirmingDelete(true)}
              deleteHint="Permanently deletes the automation and its run history."
            />
          )}
        </TabsContent>

        <TabsContent
          value="history"
          className="min-h-0 flex-1 space-y-4 overflow-y-auto pt-4 pb-28"
        >
          <p className="text-xs text-muted-foreground">
            Every time this automation ran, and what it did — including the times it decided to do
            nothing. This is where you find out why something didn't fire.
          </p>
          <RunHistory automationId={id} />
        </TabsContent>
      </Tabs>

      {!readOnly && tab === "config" && (
        <div className="pointer-events-none absolute right-6 bottom-6 z-10 flex flex-col items-end gap-2">
          {save.error && (
            <p className="pointer-events-auto max-w-md rounded-md border border-destructive/30 bg-background px-3 py-2 text-xs text-destructive shadow-lg">
              {(save.error as Error).message}
            </p>
          )}
          <div className="pointer-events-auto flex gap-2">
            <Button
              variant="outline"
              className="shadow-lg"
              onClick={() => navigate("/automations")}
            >
              {dirty ? "Cancel" : "Back"}
            </Button>
            <Button
              className="shadow-lg"
              onClick={() => save.mutate()}
              disabled={save.isPending || !dirty}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {blocker.state === "blocked" && (
        <ConfirmDialog
          title="Discard changes?"
          message="Your edits to this automation haven't been saved."
          confirmLabel="Discard"
          confirmVariant="danger"
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        />
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title="Delete automation?"
          message={`"${name.trim() || "Untitled automation"}" and its run history will be permanently deleted.`}
          confirmLabel="Delete"
          confirmVariant="danger"
          pending={del.isPending}
          error={del.error ? (del.error as Error).message : undefined}
          onConfirm={() => del.mutate()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  )
}

/** The When block: trigger kind + whatever that kind narrows by. */
function TriggerEditor({
  value,
  onChange,
  disabled,
}: {
  value: AutomationTrigger
  onChange: (t: AutomationTrigger) => void
  disabled?: boolean
}) {
  const { data: concepts = [] } = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  const live = concepts.filter((c) => !c.archivedAt)
  const fields = useFields(value.conceptId ?? "")
  const opt = TRIGGER_OPTIONS.find((o) => o.kind === value.kind)
  const statuses = useQuery({ queryKey: ["taskStatuses"], queryFn: () => api.listTaskStatuses() })

  // Only computed decay/momentum fields can carry a band.
  const computedFields = (fields.data ?? []).filter((f) => f.kind === "computed")
  const changeableFields = (fields.data ?? []).filter(
    (f) => f.kind !== "relation" && f.kind !== "file",
  )

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Trigger">
          <Select
            value={value.kind}
            onValueChange={(k) =>
              // Reset the kind-specific narrowing: a fieldId from another kind
              // would be meaningless (and could silently never match).
              onChange({
                kind: k as AutomationTrigger["kind"],
                conceptId: value.conceptId ?? null,
                ...(k === "schedule" ? { every: "week", weekday: 1, hour: 9 } : {}),
              })
            }
            disabled={disabled}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRIGGER_OPTIONS.map((o) => (
                <SelectItem key={o.kind} value={o.kind}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {opt?.concept && (
          <Field
            label={value.kind === "schedule" ? "Sweep this concept" : "Concept"}
            hint={
              value.kind === "schedule"
                ? "Runs once per matching record."
                : "Leave as Any to match every concept."
            }
          >
            <Select
              value={value.conceptId ?? NONE}
              onValueChange={(v) =>
                onChange({
                  ...value,
                  conceptId: v === NONE ? null : v,
                  // The field ids belong to the old concept.
                  fieldId: null,
                })
              }
              disabled={disabled}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Any concept</SelectItem>
                {live.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>

      {opt?.hint && <p className="text-xs text-muted-foreground">{opt.hint}</p>}

      {value.kind === "record.changed" && value.conceptId && (
        <Field label="Only when this field changes" hint="Leave as Any field to fire on any edit.">
          <Select
            value={value.fieldId ?? NONE}
            onValueChange={(v) => onChange({ ...value, fieldId: v === NONE ? null : v })}
            disabled={disabled}
          >
            <SelectTrigger className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Any field</SelectItem>
              {changeableFields.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {value.kind === "record.band.changed" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Computed field">
            <Select
              value={value.fieldId ?? NONE}
              onValueChange={(v) => onChange({ ...value, fieldId: v === NONE ? null : v })}
              disabled={disabled}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick a decay field" />
              </SelectTrigger>
              <SelectContent>
                {computedFields.length === 0 && (
                  <SelectItem value={NONE} disabled>
                    This concept has no computed field
                  </SelectItem>
                )}
                {computedFields.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Becomes">
            <Select
              value={value.band ?? NONE}
              onValueChange={(v) => onChange({ ...value, band: v === NONE ? null : v })}
              disabled={disabled}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Any band</SelectItem>
                {["fresh", "warm", "cooling", "cold", "heating", "steady"].map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}

      {value.kind === "task.status.changed" && (
        <Field label="Becomes this status">
          <Select
            value={value.statusId ?? NONE}
            onValueChange={(v) => onChange({ ...value, statusId: v === NONE ? null : v })}
            disabled={disabled}
          >
            <SelectTrigger className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Any status</SelectItem>
              {(statuses.data ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {value.kind === "schedule" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="How often">
            <Select
              value={value.every ?? "day"}
              onValueChange={(v) => onChange({ ...value, every: v as "day" | "week" | "month" })}
              disabled={disabled}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Every day</SelectItem>
                <SelectItem value="week">Every week</SelectItem>
                <SelectItem value="month">Every month</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {value.every === "week" && (
            <Field label="On">
              <Select
                value={String(value.weekday ?? 1)}
                onValueChange={(v) => onChange({ ...value, weekday: Number(v) })}
                disabled={disabled}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    "Sunday",
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                  ].map((d, i) => (
                    <SelectItem key={d} value={String(i)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {value.every === "month" && (
            <Field label="Day of month" hint="1–28, so every month has it.">
              <Input
                type="number"
                min={1}
                max={28}
                value={value.day ?? 1}
                onChange={(e) =>
                  onChange({
                    ...value,
                    day: Math.min(28, Math.max(1, Number(e.target.value) || 1)),
                  })
                }
                disabled={disabled}
              />
            </Field>
          )}
          <Field label="At (UTC)">
            <Input
              type="number"
              min={0}
              max={23}
              value={value.hour ?? 9}
              onChange={(e) =>
                onChange({
                  ...value,
                  hour: Math.min(23, Math.max(0, Number(e.target.value) || 0)),
                })
              }
              disabled={disabled}
            />
          </Field>
        </div>
      )}
    </div>
  )
}

/** One row in the Then block; the editors vary by action kind. */
function ActionEditor({
  action,
  conceptId,
  onChange,
  onRemove,
  disabled,
}: {
  action: AutomationAction
  conceptId: string
  onChange: (a: AutomationAction) => void
  onRemove: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(true)
  const fields = useFields(conceptId)
  const { data: concepts = [] } = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  const { data: labels = [] } = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
  const meta = ACTION_OPTIONS.find((o) => o.kind === action.kind)
  const writableFields = (fields.data ?? []).filter(
    (f) => f.kind !== "relation" && f.kind !== "file" && f.kind !== "computed",
  )

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            size={14}
            className={`shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
          />
          <span className="text-sm font-medium text-foreground">{meta?.label ?? action.kind}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {describeAction(action)}
          </span>
        </button>
        {!disabled && (
          <IconButton aria-label="Remove action" onClick={onRemove}>
            <X size={14} />
          </IconButton>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-3 pl-6">
          {action.kind === "setField" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Field">
                <Select
                  value={action.fieldId || NONE}
                  onValueChange={(v) => onChange({ ...action, fieldId: v === NONE ? "" : v })}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick a field" />
                  </SelectTrigger>
                  <SelectContent>
                    {writableFields.length === 0 && (
                      <SelectItem value={NONE} disabled>
                        Pick a concept in the When block first
                      </SelectItem>
                    )}
                    {writableFields.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Value" hint="Supports {{tokens}}.">
                <Input
                  value={String(action.value ?? "")}
                  onChange={(e) => onChange({ ...action, value: e.target.value })}
                  disabled={disabled}
                />
              </Field>
            </div>
          )}

          {(action.kind === "addLabel" || action.kind === "removeLabel") && (
            <Field label="Label">
              <Select
                value={action.labelId || NONE}
                onValueChange={(v) => onChange({ ...action, labelId: v === NONE ? "" : v })}
                disabled={disabled}
              >
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue placeholder="Pick a label" />
                </SelectTrigger>
                <SelectContent>
                  {labels
                    .filter((l) => !l.archivedAt)
                    .map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {action.kind === "createTask" && (
            <div className="space-y-3">
              <Field label="Title" hint="Supports {{tokens}}.">
                <Input
                  value={action.title}
                  onChange={(e) => onChange({ ...action, title: e.target.value })}
                  placeholder="Follow up on {{record.title}}"
                  disabled={disabled}
                />
              </Field>
              <Field label="Due in (days)" hint="Leave empty for no due date.">
                <Input
                  type="number"
                  min={0}
                  value={action.dueInDays ?? ""}
                  onChange={(e) =>
                    onChange({
                      ...action,
                      dueInDays: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  className="w-32"
                  disabled={disabled}
                />
              </Field>
              <TokenHint />
            </div>
          )}

          {action.kind === "createRecord" && (
            <Field label="Concept">
              <Select
                value={action.conceptId || NONE}
                onValueChange={(v) => onChange({ ...action, conceptId: v === NONE ? "" : v })}
                disabled={disabled}
              >
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue placeholder="Pick a concept" />
                </SelectTrigger>
                <SelectContent>
                  {concepts
                    .filter((c) => !c.archivedAt)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {action.kind === "archiveRecord" && (
            <p className="text-xs text-muted-foreground">
              Archives the record that triggered this automation. Archive is reversible — an
              automation is never allowed to permanently delete.
            </p>
          )}

          {action.kind === "notifySlack" && (
            <div className="space-y-3">
              <Field label="Channel">
                <Input
                  value={action.channel}
                  onChange={(e) => onChange({ ...action, channel: e.target.value })}
                  placeholder="#wins"
                  disabled={disabled}
                />
              </Field>
              <Field label="Message" hint="Supports {{tokens}}.">
                <Input
                  value={action.text}
                  onChange={(e) => onChange({ ...action, text: e.target.value })}
                  placeholder="{{record.title}} just moved to {{trigger.to}}"
                  disabled={disabled}
                />
              </Field>
              <TokenHint />
            </div>
          )}

          {action.kind === "webhook" && (
            <div className="space-y-3">
              <Field label="URL" hint="Must be http(s).">
                <Input
                  value={action.url}
                  onChange={(e) => onChange({ ...action, url: e.target.value })}
                  placeholder="https://example.com/hook"
                  disabled={disabled}
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                POSTs JSON with the automation id, the record id and its concept. This is the one
                action that sends org data outside Kingsmaker.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TokenHint() {
  return (
    <InfoHint
      label="Which tokens can I use?"
      text={
        <ul className="space-y-0.5">
          {TEMPLATE_TOKENS.map((t) => (
            <li key={t.token}>
              <code>{t.token}</code> — {t.means}
            </li>
          ))}
        </ul>
      }
    />
  )
}

/** The last 20 runs — the answer to "why didn't it fire?". */
function RunHistory({ automationId }: { automationId: string }) {
  const runs = automationRunsFor(automationId)
  const { data: rows = [] } = useLiveQuery((q) => q.from({ r: runs }))
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
    [rows],
  )

  return (
    <Card>
      <CardHeader
        title="Recent runs"
        action={<span className="text-xs text-muted-foreground">last {sorted.length}</span>}
      />
      {sorted.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No runs yet. A skipped run is recorded too, so this is where you find out why something
          didn't fire.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {sorted.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-4 py-2.5">
              <Badge tone={r.status === "ok" ? "green" : r.status === "failed" ? "red" : "gray"}>
                {r.status}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">
                  {new Date(r.startedAt).toLocaleString()}
                </p>
                {r.detail.reason && (
                  <p className="text-xs text-muted-foreground">skipped: {r.detail.reason}</p>
                )}
                {r.detail.error && <p className="text-xs text-destructive">{r.detail.error}</p>}
                {r.detail.actions?.map((a, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: outcomes are positional
                  <p key={i} className="truncate text-xs text-foreground">
                    {a.ok ? "✓" : "✗"} {a.kind}
                    {a.note ? ` — ${a.note}` : ""}
                  </p>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
