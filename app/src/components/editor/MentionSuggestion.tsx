/**
 * The `@` menu: type `@`, pick a thing, get a chip.
 *
 * COMPOSITION, not one endpoint. Four of the five kinds are already in memory —
 * people (the org member list), concepts and dashboards (both already
 * permission-filtered by their list reads), and pages (a static table) — so they
 * are matched locally with no round-trip. Only `record` needs the server, because
 * there is no cross-concept record search short of one.
 *
 * The query is deliberately NOT run on a bare `@`: that would put an org-wide head
 * scan behind every stray keystroke. The menu shows the local kinds immediately and
 * folds records in once there is something to match on.
 *
 * `file` is absent on purpose. Attachments are per-record or per-bucket with no
 * org-wide search and no readable-subject story for bucket files, so there is
 * nothing sound to list here yet — a file mention created another way still
 * resolves and renders. The natural home is a "copy as mention" action in the
 * Files panel.
 */

import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "../../lib/api"
import { useMembers } from "../../lib/members"
import { MENTION_KIND_DEFS, type MentionKind } from "../../lib/mentionKinds"
import { GLOBAL_NAV, useConcepts, useDashboards } from "../../lib/sidebarViews"
import { cn } from "../../lib/utils"

export interface MentionCandidate {
  readonly kind: MentionKind
  readonly targetId: string
  readonly label: string
  readonly subtitle?: string | null
}

/** Kind order in the menu: records first, because that is the common case. */
const KIND_ORDER: ReadonlyArray<MentionKind> = ["record", "person", "concept", "dashboard", "page"]

const matches = (haystack: string, needle: string) =>
  haystack.toLowerCase().includes(needle.toLowerCase())

/** Everything mentionable that is already in memory. */
export function useLocalCandidates(query: string): ReadonlyArray<MentionCandidate> {
  const { members, deactivatedSet } = useMembers()
  const concepts = useConcepts()
  const dashboards = useDashboards()

  return useMemo(() => {
    const q = query.trim()
    if (q === "") return []
    const out: MentionCandidate[] = []

    for (const m of members) {
      // Deactivated members are dropped from the PICKER (nobody should newly
      // point at them) while existing mentions of them still resolve — the same
      // split `assertMembers` draws for assignment.
      if (deactivatedSet.has(m.userId)) continue
      const label = m.user?.name?.trim() || m.user?.email || m.userId
      if (matches(label, q)) out.push({ kind: "person", targetId: m.userId, label })
    }
    for (const c of concepts) {
      // Only a single-record concept has a member-reachable page; the rest would
      // resolve to an inert chip, so they are not offered.
      if (!c.singleRecord) continue
      if (matches(c.name, q)) out.push({ kind: "concept", targetId: c.id, label: c.name })
    }
    for (const d of dashboards) {
      if (matches(d.name, q)) out.push({ kind: "dashboard", targetId: d.id, label: d.name })
    }
    for (const p of GLOBAL_NAV) {
      if (matches(p.label, q)) out.push({ kind: "page", targetId: p.key, label: p.label })
    }
    return out
  }, [query, members, deactivatedSet, concepts, dashboards])
}

/** Local candidates plus server-matched records, grouped by kind. */
export function useMentionCandidates(query: string) {
  const local = useLocalCandidates(query)
  const q = query.trim()
  const { data: records } = useQuery({
    queryKey: ["mentionable-records", q],
    queryFn: () => api.searchMentionableRecords(q, 10),
    // Never on a bare `@` — see the note at the top of this file.
    enabled: q.length > 0,
    staleTime: 15_000,
  })

  return useMemo(() => {
    const all: MentionCandidate[] = [
      ...(records ?? []).map((r) => ({
        kind: "record" as const,
        targetId: r.targetId,
        label: r.label ?? "(untitled)",
        subtitle: r.subtitle,
      })),
      ...local,
    ]
    return KIND_ORDER.map((kind) => ({
      kind,
      items: all.filter((c) => c.kind === kind),
    })).filter((g) => g.items.length > 0)
  }, [records, local])
}

/**
 * The floating menu itself. Keyboard state is owned HERE rather than by cmdk:
 * the suggestion plugin already intercepts arrow/enter at the ProseMirror level
 * and hands them over through an imperative ref, and bridging that into cmdk's
 * controlled-highlight (see `FilterBar`'s comments on the same fight) buys nothing
 * for a list this shape.
 */
export interface MentionMenuHandle {
  onKeyDown: (e: KeyboardEvent) => boolean
}

export function MentionMenu({
  query,
  onPick,
  handleRef,
}: {
  query: string
  onPick: (c: MentionCandidate) => void
  handleRef: React.MutableRefObject<MentionMenuHandle | null>
}) {
  const groups = useMentionCandidates(query)
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const [index, setIndex] = useState(0)
  const pickRef = useRef(onPick)
  pickRef.current = onPick

  // Clamped on read rather than reset in an effect: as results stream in, the
  // list shrinks and grows under the cursor, and an effect would fight that with
  // an extra render every time.
  const active = flat.length === 0 ? 0 : Math.min(index, flat.length - 1)

  useEffect(() => {
    handleRef.current = {
      onKeyDown: (e: KeyboardEvent) => {
        if (flat.length === 0) return false
        if (e.key === "ArrowDown") {
          setIndex((i) => (i + 1) % flat.length)
          return true
        }
        if (e.key === "ArrowUp") {
          setIndex((i) => (i - 1 + flat.length) % flat.length)
          return true
        }
        if (e.key === "Enter") {
          const hit = flat[active]
          if (hit) pickRef.current(hit)
          return true
        }
        return false
      },
    }
    return () => {
      handleRef.current = null
    }
  }, [flat, active, handleRef])

  if (flat.length === 0) {
    return (
      <div className="w-72 rounded-md border border-border bg-popover p-2 text-muted-foreground text-sm shadow-md">
        {query.trim() === "" ? "Type to search…" : "No matches"}
      </div>
    )
  }

  let running = -1
  return (
    <div className="max-h-72 w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
      {groups.map((g) => (
        <div key={g.kind}>
          <p className="px-2 py-1 font-medium text-muted-foreground text-xs">
            {MENTION_KIND_DEFS[g.kind].label}
          </p>
          {g.items.map((c) => {
            running += 1
            const isActive = running === active
            const Icon = MENTION_KIND_DEFS[c.kind].Icon
            return (
              <button
                type="button"
                key={`${c.kind}:${c.targetId}`}
                // `onMouseDown` with preventDefault, not onClick: a click would
                // blur the editor first, collapsing the selection the plugin
                // needs in order to replace the `@…` text.
                onMouseDown={(e) => {
                  e.preventDefault()
                  onPick(c)
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                  isActive ? "bg-accent" : "hover:bg-accent/50",
                )}
              >
                <Icon size={14} className="shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.subtitle && (
                  <span className="shrink-0 text-muted-foreground text-xs">{c.subtitle}</span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
