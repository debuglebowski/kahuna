import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Link } from "react-router-dom"
import { api, type DashboardWidget } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { useMembers } from "@/lib/members"
import { recordHref } from "@/lib/recordHref"
import { cn } from "@/lib/utils"
import { renderWelcome, WELCOME_MESSAGES } from "@/lib/welcomeMessages"
import { ShortcutItemGlyph, urlHref } from "./ShortcutsWidget"

type Welcome = Extract<DashboardWidget, { type: "welcome" }>
type WelcomeLink = NonNullable<Welcome["links"]>[number]

const WEEK_MS = 7 * 86_400_000
/** listEvents cap for the pulse count — render "500+" once we hit it. */
const PULSE_LIMIT = 500

/** "12 members · 87 events this week" — the org's heartbeat in one line. */
function PulseLine() {
  const { members } = useMembers()
  const eventsQ = useQuery({
    queryKey: ["events", null, "pulse"],
    queryFn: () => api.listEvents({ since: Date.now() - WEEK_MS, limit: PULSE_LIMIT }),
  })
  if (members.length === 0 && !eventsQ.data) return null
  const n = eventsQ.data?.length ?? 0
  const events = eventsQ.data
    ? `${n >= PULSE_LIMIT ? `${PULSE_LIMIT}+` : n} events this week`
    : null
  return (
    <p className="text-sm text-muted-foreground">
      {members.length} {members.length === 1 ? "member" : "members"}
      {events ? ` · ${events}` : ""}
    </p>
  )
}

/** The curated quick links as a chip row (same targets as Shortcuts items). */
function QuickLinks({ links }: { links: ReadonlyArray<WelcomeLink> }) {
  // Dashboard targets re-resolve to the live name (shares the page's query).
  const hasDashboardItems = links.some((i) => i.kind === "dashboard")
  const { data: dashboards } = useQuery({
    queryKey: ["dashboards"],
    queryFn: () => api.listDashboards(),
    enabled: hasDashboardItems,
  })
  const labelOf = (item: WelcomeLink): string => {
    if (item.kind === "dashboard")
      return dashboards?.find((d) => d.id === item.ref)?.name ?? item.label ?? "Dashboard"
    return item.label || item.ref
  }
  const chipClass =
    "inline-flex max-w-56 items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm text-foreground transition hover:bg-accent"
  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map((item) =>
        item.kind === "url" ? (
          <a key={item.id} href={urlHref(item.ref)} className={chipClass}>
            <ShortcutItemGlyph kind={item.kind} />
            <span className="truncate">{labelOf(item)}</span>
          </a>
        ) : (
          <Link
            key={item.id}
            to={item.kind === "dashboard" ? `/dashboards/${item.ref}` : recordHref(item.ref)}
            className={chipClass}
          >
            <ShortcutItemGlyph kind={item.kind} />
            <span className="truncate">{labelOf(item)}</span>
          </Link>
        ),
      )}
    </div>
  )
}

/**
 * The canvas's handshake: a greeting plus optional org pulse and quick links.
 * The message is drawn once per mount (re-renders must not reshuffle it), but
 * the `{name}` token fills per render so a slow-resolving session still ends
 * up greeting the viewer by name. `hero` = big banner; `card` = compact
 * orientation card.
 */
export function WelcomeWidget({ widget }: { widget: Welcome }) {
  const { data: session } = useSession()
  const [msg] = useState(
    () => WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)]!,
  )
  const card = widget.variant === "card"
  const links = widget.links ?? []

  return (
    // cancel-drag: clicking a quick link must never start a tile drag.
    <div
      className={cn(
        "cancel-drag flex h-full flex-col justify-center gap-2 overflow-hidden",
        card && "gap-1.5",
      )}
    >
      <h1
        className={cn(
          "leading-tight font-bold tracking-tight text-balance text-foreground",
          card ? "text-lg" : "text-3xl",
        )}
      >
        {renderWelcome(msg, session?.user.name)}
      </h1>
      {(widget.showPulse ?? false) && <PulseLine />}
      {links.length > 0 && <QuickLinks links={links} />}
    </div>
  )
}
