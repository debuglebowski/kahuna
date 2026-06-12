import { useQuery } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react"
import { useState } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, type Concept, type DashboardWidget } from "@/lib/api"
import { Button, IconButton, Input } from "../ui"
import { ShortcutItemGlyph } from "./ShortcutsWidget"

type Shortcuts = Extract<DashboardWidget, { type: "shortcuts" }>
type Item = Shortcuts["items"][number]

/**
 * The Shortcuts widget's ordered item list — rows with reorder/remove, plus an
 * add form whose target picker switches by kind: instance (concept + search,
 * mirrors the relation picker), dashboard (select), or URL (free input). Labels
 * are snapshotted at pick time; dashboards re-resolve live in the renderer.
 */
export function ShortcutItemsEditor({
  items,
  concepts,
  onChange,
}: {
  items: ReadonlyArray<Item>
  concepts: readonly Concept[]
  onChange: (items: ReadonlyArray<Item>) => void
}) {
  const [kind, setKind] = useState<Item["kind"]>("instance")
  const [conceptId, setConceptId] = useState("")
  const [query, setQuery] = useState("")
  const [url, setUrl] = useState("")
  const [urlLabel, setUrlLabel] = useState("")

  const { data: dashboards } = useQuery({
    queryKey: ["dashboards"],
    queryFn: () => api.listDashboards(),
    enabled: kind === "dashboard",
  })
  const results = useQuery({
    queryKey: ["search", conceptId, query],
    queryFn: () => api.searchInstances(conceptId, query),
    enabled: kind === "instance" && !!conceptId,
  })

  const add = (item: Omit<Item, "id">) => onChange([...items, { ...item, id: crypto.randomUUID() }])
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    const tmp = next[i]!
    next[i] = next[j]!
    next[j] = tmp
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {items.length > 0 && (
        <div className="space-y-0.5">
          {items.map((item, i) => (
            <div key={item.id} className="group flex items-center gap-2 rounded px-1.5 py-1">
              <ShortcutItemGlyph kind={item.kind} />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {item.label || item.ref}
              </span>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                <IconButton aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={13} />
                </IconButton>
                <IconButton
                  aria-label="Move down"
                  disabled={i === items.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown size={13} />
                </IconButton>
                <IconButton
                  aria-label="Remove shortcut"
                  onClick={() => onChange(items.filter((x) => x.id !== item.id))}
                >
                  <X size={14} />
                </IconButton>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2 rounded-md border border-border p-2.5">
        <Select value={kind} onValueChange={(v) => setKind(v as Item["kind"])}>
          <SelectTrigger className="w-full" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="instance">Instance</SelectItem>
            <SelectItem value="dashboard">Dashboard</SelectItem>
            <SelectItem value="url">URL</SelectItem>
          </SelectContent>
        </Select>

        {kind === "instance" && (
          <>
            <Select
              value={conceptId || "__none"}
              onValueChange={(v) => setConceptId(v === "__none" ? "" : v)}
            >
              <SelectTrigger className="w-full" size="sm">
                <SelectValue placeholder="Concept…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Concept…</SelectItem>
                {concepts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.pluralName || c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {conceptId && (
              <>
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                />
                <div className="max-h-36 space-y-0.5 overflow-y-auto">
                  {(results.data ?? []).map((r) => (
                    <button
                      key={r.itemId}
                      type="button"
                      onClick={() => add({ kind: "instance", ref: r.instanceId, label: r.label })}
                      className="flex w-full items-center rounded px-2 py-1 text-left text-sm hover:bg-accent"
                    >
                      {r.label}
                    </button>
                  ))}
                  {results.data?.length === 0 && (
                    <p className="px-2 py-1 text-sm text-muted-foreground">No items match.</p>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {kind === "dashboard" && (
          <Select
            value="__none"
            onValueChange={(v) => {
              const d = dashboards?.find((x) => x.id === v)
              if (d) add({ kind: "dashboard", ref: d.id, label: d.name })
            }}
          >
            <SelectTrigger className="w-full" size="sm">
              <SelectValue placeholder="Pick a dashboard…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">Pick a dashboard…</SelectItem>
              {(dashboards ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                  {d.ownerId ? " · personal" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {kind === "url" && (
          <>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            <Input
              value={urlLabel}
              onChange={(e) => setUrlLabel(e.target.value)}
              placeholder="Label (optional)"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!url.trim()}
              onClick={() => {
                add({ kind: "url", ref: url.trim(), label: urlLabel.trim() || null })
                setUrl("")
                setUrlLabel("")
              }}
            >
              <Plus size={14} /> Add link
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
