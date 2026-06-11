import { useQuery } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import { useState } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  api,
  type Concept,
  type Dashboard,
  type Label,
  type SidebarRule,
  type SidebarSection,
  type SidebarSource,
} from "../../lib/api"
import { ConditionList } from "../ConditionList"
import { IconPicker } from "../IconPicker"
import { MultiCombobox } from "../MultiCombobox"
import { Button, Field as FieldRow, IconButton, Input, Modal } from "../ui"

/**
 * Edits a single sidebar section: title, icon, and its content source. Sources
 * resolve client-side (see `lib/sidebarViews`); this is purely the authoring UI.
 * Rule conditions are limited to equality + has-label (the chosen v1 power);
 * manual instance pinning is supported by the model but not yet by this editor.
 */

const STATIC_ITEMS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "tasks", label: "Tasks" },
  { key: "dashboards", label: "Dashboards" },
  { key: "members", label: "Members" },
  { key: "automations", label: "Automations" },
  { key: "settings", label: "Settings" },
]

const SOURCE_KINDS: ReadonlyArray<{ kind: SidebarSource["kind"]; label: string }> = [
  { kind: "static", label: "Global items" },
  { kind: "group", label: "Dashboard group" },
  { kind: "list", label: "Item list" },
  { kind: "links", label: "Links" },
]

const emptySource = (kind: SidebarSource["kind"]): SidebarSource => {
  switch (kind) {
    case "static":
      return { kind: "static", items: [] }
    case "list":
      return { kind: "list", conceptId: "", conditions: [] }
    case "links":
      return { kind: "links", items: [] }
    default:
      return { kind: "group", members: [], rules: [] }
  }
}

/** A blank section (group by default — the most common case; title left empty). */
export const newSection = (): SidebarSection => ({
  id: crypto.randomUUID(),
  title: null,
  icon: null,
  source: { kind: "group", members: [], rules: [] },
})

function DashboardMultiSelect({
  dashboards,
  selectedIds,
  onChange,
}: {
  dashboards: readonly Dashboard[]
  selectedIds: readonly string[]
  onChange: (ids: string[]) => void
}) {
  if (dashboards.length === 0)
    return <p className="text-xs text-muted-foreground">No dashboards yet.</p>
  const options = [...dashboards]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ id: d.id, label: d.name }))
  return (
    <MultiCombobox
      options={options}
      selectedIds={selectedIds}
      onChange={onChange}
      placeholder="Dashboard"
      searchPlaceholder="Search dashboards…"
      emptyText="No matching dashboards."
    />
  )
}

/** The rule list for a group: every dashboard, or matching instances of a concept. */
function RuleList({
  rules,
  concepts,
  labels,
  onChange,
}: {
  rules: readonly SidebarRule[]
  concepts: readonly Concept[]
  labels: readonly Label[]
  onChange: (next: SidebarRule[]) => void
}) {
  const set = (i: number, r: SidebarRule) => onChange(rules.map((x, j) => (j === i ? r : x)))
  const remove = (i: number) => onChange(rules.filter((_, j) => j !== i))

  return (
    <div className="space-y-2">
      {rules.map((rule, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional
        <div key={i} className="rounded-md border border-border p-2">
          <div className="flex items-center gap-1.5">
            <Select
              value={rule.target}
              onValueChange={(v) =>
                set(
                  i,
                  v === "dashboards"
                    ? { target: "dashboards" }
                    : { target: "items", conceptId: concepts[0]?.id ?? "", conditions: [] },
                )
              }
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dashboards">All dashboards</SelectItem>
                <SelectItem value="items">Items of…</SelectItem>
              </SelectContent>
            </Select>
            {rule.target === "items" && (
              <Select
                value={rule.conceptId}
                onValueChange={(v) => set(i, { ...rule, conceptId: v })}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select a concept…" />
                </SelectTrigger>
                <SelectContent>
                  {concepts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.pluralName || c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <IconButton aria-label="Remove rule" onClick={() => remove(i)} className="ml-auto">
              <X size={14} />
            </IconButton>
          </div>
          {rule.target === "items" && (
            <div className="mt-1.5">
              <ConditionList
                conceptId={rule.conceptId}
                conditions={rule.conditions}
                labels={labels}
                onChange={(conditions) => set(i, { ...rule, conditions })}
                match={rule.match ?? "all"}
                onMatchChange={(match) => set(i, { ...rule, match })}
              />
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rules, { target: "dashboards" }])}
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        + Rule
      </button>
    </div>
  )
}

export function SectionEditor({
  section,
  concepts,
  onSave,
  onClose,
}: {
  section: SidebarSection
  concepts: readonly Concept[]
  onSave: (section: SidebarSection) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<SidebarSection>(section)
  const labelsQ = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
  const labels = labelsQ.data ?? []
  const dashboardsQ = useQuery({ queryKey: ["dashboards"], queryFn: () => api.listDashboards() })
  const dashboards = dashboardsQ.data ?? []
  const src = draft.source
  const setSource = (source: SidebarSource) => setDraft((d) => ({ ...d, source }))

  return (
    <Modal title="Edit section" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-end gap-2">
          <IconPicker value={draft.icon} onChange={(icon) => setDraft((d) => ({ ...d, icon }))} />
          <div className="flex-1">
            <FieldRow label="Title (optional)">
              <Input
                value={draft.title ?? ""}
                placeholder="Section heading…"
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value || null }))}
              />
            </FieldRow>
          </div>
        </div>

        <FieldRow label="Content">
          <Select
            value={src.kind}
            onValueChange={(v) => setSource(emptySource(v as SidebarSource["kind"]))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_KINDS.map((s) => (
                <SelectItem key={s.kind} value={s.kind}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>

        {src.kind === "static" && (
          <div className="flex flex-wrap gap-1.5">
            {STATIC_ITEMS.map((it) => {
              const on = src.items.includes(it.key as never)
              return (
                <button
                  key={it.key}
                  type="button"
                  onClick={() =>
                    setSource({
                      kind: "static",
                      items: (on
                        ? src.items.filter((x) => x !== it.key)
                        : [...src.items, it.key]) as never,
                    })
                  }
                  className={
                    on
                      ? "rounded-full bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
                      : "rounded-full border border-input px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
                  }
                >
                  {it.label}
                </button>
              )
            })}
          </div>
        )}

        {src.kind === "group" && (
          <div className="space-y-3">
            <FieldRow label="Pinned dashboards">
              <DashboardMultiSelect
                dashboards={dashboards}
                selectedIds={src.members
                  .filter((m) => m.kind === "dashboard")
                  .map((m) => m.dashboardId)}
                onChange={(ids) =>
                  setSource({
                    ...src,
                    members: [
                      ...ids.map((dashboardId) => ({ kind: "dashboard" as const, dashboardId })),
                      ...src.members.filter((m) => m.kind === "instance"),
                    ],
                  })
                }
              />
            </FieldRow>
            <FieldRow label="Rules">
              <RuleList
                rules={src.rules}
                concepts={concepts}
                labels={labels}
                onChange={(rules) => setSource({ ...src, rules })}
              />
            </FieldRow>
          </div>
        )}

        {src.kind === "list" && (
          <div className="space-y-3">
            <FieldRow label="Concept">
              <Select
                value={src.conceptId || "__none"}
                onValueChange={(v) => setSource({ ...src, conceptId: v === "__none" ? "" : v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a concept…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Select a concept…</SelectItem>
                  {concepts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.pluralName || c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
            {src.conceptId && (
              <FieldRow label="Filter">
                <ConditionList
                  conceptId={src.conceptId}
                  conditions={src.conditions}
                  labels={labels}
                  onChange={(conditions) => setSource({ ...src, conditions })}
                  match={src.match ?? "all"}
                  onMatchChange={(match) => setSource({ ...src, match })}
                />
              </FieldRow>
            )}
            <FieldRow label="Max items (optional)">
              <Input
                type="number"
                min={1}
                value={src.limit ?? ""}
                onChange={(e) =>
                  setSource({ ...src, limit: e.target.value ? Number(e.target.value) : null })
                }
                className="w-28"
              />
            </FieldRow>
          </div>
        )}

        {src.kind === "links" && (
          <div className="space-y-2">
            {src.items.map((l, i) => (
              <div key={l.id} className="flex items-center gap-1.5">
                <IconPicker
                  value={l.icon ?? null}
                  onChange={(icon) =>
                    setSource({
                      kind: "links",
                      items: src.items.map((x, j) => (j === i ? { ...x, icon } : x)),
                    })
                  }
                />
                <Input
                  value={l.label}
                  placeholder="Label"
                  onChange={(e) =>
                    setSource({
                      kind: "links",
                      items: src.items.map((x, j) =>
                        j === i ? { ...x, label: e.target.value } : x,
                      ),
                    })
                  }
                  className="w-32"
                />
                <Input
                  value={l.to}
                  placeholder="/path or https://…"
                  onChange={(e) =>
                    setSource({
                      kind: "links",
                      items: src.items.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)),
                    })
                  }
                  className="flex-1"
                />
                <IconButton
                  aria-label="Remove link"
                  onClick={() =>
                    setSource({ kind: "links", items: src.items.filter((_, j) => j !== i) })
                  }
                >
                  <X size={14} />
                </IconButton>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setSource({
                  kind: "links",
                  items: [...src.items, { id: crypto.randomUUID(), label: "", to: "" }],
                })
              }
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              + Link
            </button>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button
            onClick={() => {
              onSave(draft)
              onClose()
            }}
          >
            <Plus size={15} /> Save section
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  )
}
