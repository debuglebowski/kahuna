import { Check, ExternalLink, X } from "lucide-react"
import { Fragment, type ReactNode } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge, decayTone, LabelChip, momentumTone } from "../components/ui"
import { useFullOrg } from "../pages/settings/SettingsLayout"
import type { DecayValue, Field, MomentumValue } from "./api"
import { initialsOf, showValue } from "./utils"

/** Matches the engine's `url` format validator. */
const URL_RE = /^https?:\/\/\S+$/

/** Compact host+path label for a URL, falling back to the raw string. */
export const urlLabel = (href: string): string => {
  try {
    const u = new URL(href)
    return u.host + (u.pathname === "/" ? "" : u.pathname)
  } catch {
    return href
  }
}

/** "$1,234.50" via Intl, tolerating an unknown currency code. */
export const formatMoney = (v: unknown): string | null => {
  const m = v as { amount?: unknown; currency?: unknown }
  if (typeof m?.amount !== "number") return null
  const currency = typeof m.currency === "string" && m.currency ? m.currency : "USD"
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(m.amount)
  } catch {
    return `${m.amount} ${currency}`
  }
}

/** Display-only: enum options are stored lowercase-ish; show them capitalized. */
const capitalize = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

const empty = <span className="text-muted-foreground">—</span>

/** Out-link that doesn't trigger the clickable row it sits in. */
function UrlLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex max-w-64 items-center gap-1 align-middle text-info hover:underline"
    >
      <span className="truncate">{urlLabel(href)}</span>
      <ExternalLink size={12} className="shrink-0" />
    </a>
  )
}

/** Org-member pills (avatar + name) for a `user` value; click mails the member. */
function UserPills({ ids }: { ids: ReadonlyArray<string> }) {
  const org = useFullOrg()
  const members = org.data?.members ?? []
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {ids.map((id) => {
        const m = members.find((x) => x.userId === id)
        const email = m?.user?.email
        const name = m?.user?.name?.trim() || email || id
        return (
          <a
            key={id}
            href={email ? `mailto:${email}` : undefined}
            title={email}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 rounded-full bg-muted py-0.5 pr-2.5 pl-1 text-xs font-medium text-foreground hover:bg-accent"
          >
            <Avatar className="size-4">
              <AvatarImage src={m?.user?.image ?? undefined} alt="" />
              <AvatarFallback className="text-[9px]">
                {initialsOf(m?.user?.name, email ?? id)}
              </AvatarFallback>
            </Avatar>
            <span className="max-w-40 truncate">{name}</span>
          </a>
        )
      })}
    </span>
  )
}

/** A scalar (one element of a possibly-`multiple` value): auto-link URLs. */
const scalar = (v: unknown): ReactNode =>
  typeof v === "string" && URL_RE.test(v) ? <UrlLink href={v} /> : showValue(v)

const asList = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : [v])

/**
 * Kind-aware preview of one field value for tables/lists (and the instance
 * detail): URLs link out, `user` renders member pills, `bool` renders a ✓/✕
 * icon, `enum` renders pills, money/computed get their formatted shapes.
 * Anything else falls back to {@link showValue}.
 */
export function FieldValueCell({ field, value }: { field?: Field; value: unknown }) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    // Surface a missing value on fields that declare a requirement: red for
    // `required` (only reachable on rows that predate the rule), amber for
    // `flagged`.
    const req = field?.config.requirement
    if (req === "required" || req === "flagged")
      return <Badge tone={req === "required" ? "red" : "amber"}>missing</Badge>
    return empty
  }

  switch (field?.kind) {
    case "computed": {
      if (field.config.computedKind === "decay") {
        const d = value as DecayValue
        return (
          <Badge tone={decayTone(d.band)}>
            {d.band} · {d.days ?? "—"}d
          </Badge>
        )
      }
      if (field.config.computedKind === "momentum") {
        const m = value as MomentumValue
        return <Badge tone={momentumTone(m.label)}>{m.label}</Badge>
      }
      break
    }
    case "user": {
      const ids = asList(value).filter((x): x is string => typeof x === "string")
      if (ids.length === 0) return empty
      return <UserPills ids={ids} />
    }
    case "bool":
      return value === true ? (
        <Check size={16} className="text-success" aria-label="Yes" />
      ) : (
        <X size={16} className="text-muted-foreground/70" aria-label="No" />
      )
    case "enum": {
      const opts = asList(value).filter((x) => x !== null && x !== undefined && x !== "")
      if (opts.length === 0) return empty
      return (
        <span className="inline-flex flex-wrap items-center gap-1">
          {opts.map((o) => (
            <LabelChip key={String(o)} color={field.config.optionColors?.[String(o)] ?? null}>
              {capitalize(String(o))}
            </LabelChip>
          ))}
        </span>
      )
    }
    case "money": {
      const text = formatMoney(value)
      if (text) return <span>{text}</span>
      break
    }
  }

  // text / number / date / json / fallbacks (+ optional `multiple` lists)
  if (Array.isArray(value)) {
    return (
      <span>
        {value.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: plain value list, order-stable
          <Fragment key={i}>
            {i > 0 && ", "}
            {scalar(v)}
          </Fragment>
        ))}
      </span>
    )
  }
  return <span>{scalar(value)}</span>
}
