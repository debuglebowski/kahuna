/**
 * The `@` mention kind vocabulary: what can be referenced from inside rich text,
 * and how each kind is labelled and iconified in the picker and the chip.
 *
 * A mention stores three attrs — `{ kind, targetId, label }` — and nothing else.
 * `targetId` means something different per kind, and the difference is load-bearing:
 *
 *   record     `records.id` (the LINEAGE, never a `record_versions.id`) so the
 *              reference survives someone publishing a new version, matching how
 *              relations and task subjects address a record.
 *   person     `bauth_user.id` — the only stable member handle.
 *   page       a `GLOBAL_NAV` key ("overview", "tasks", …). The one non-uuid kind:
 *              it has no database row, mirroring `sidebarViews`' `global:<key>`.
 *   concept    `concepts.id` — the id, not the slug. A concept is freely renameable
 *              and its slug is only stable-by-convention, while the id never
 *              changes; store the id, render the slug URL.
 *   dashboard  `dashboards.id`.
 *   file       `attachments.id`.
 *
 * DELIBERATELY NOT unified with `ShortcutItem` (`rpc/contract.ts`), which also
 * models "a pointer to a thing" with a `{ kind, ref, label }` shape. Its
 * `"recordVersion"` kind stores a `record_versions.id` (see `ShortcutItemsEditor`,
 * which keeps `recordVersionId` and discards `recordId`) where a mention's
 * `"record"` kind stores a `records.id` — a DIFFERENT id space, now named
 * differently on purpose. Merging them would still need every stored shortcut
 * ref migrated, and picking the wrong one of the two is exactly the silent
 * wrong-link bug this split exists to make impossible.
 */

import {
  AtSign,
  Box,
  FileText,
  LayoutDashboard,
  type LucideIcon,
  Shapes,
  Signpost,
  User,
} from "lucide-react"
import { GLOBAL_NAV } from "./sidebarViews"

/** Mirrors the engine's `MENTION_KINDS`. The client tree does not import
 *  `#engine` (see `richtext.ts`, mirrored the same way) — keep the two in step. */
export const MENTION_KINDS = ["record", "person", "page", "concept", "dashboard", "file"] as const
export type MentionKind = (typeof MENTION_KINDS)[number]

const KIND_SET: ReadonlySet<string> = new Set(MENTION_KINDS)
export const isMentionKind = (v: unknown): v is MentionKind =>
  typeof v === "string" && KIND_SET.has(v)

export interface MentionKindDef {
  readonly kind: MentionKind
  /** Group heading in the `@` menu. */
  readonly label: string
  readonly Icon: LucideIcon
}

export const MENTION_KIND_DEFS: Record<MentionKind, MentionKindDef> = {
  record: { kind: "record", label: "Records", Icon: Box },
  person: { kind: "person", label: "People", Icon: User },
  page: { kind: "page", label: "Pages", Icon: Signpost },
  concept: { kind: "concept", label: "Concepts", Icon: Shapes },
  dashboard: { kind: "dashboard", label: "Dashboards", Icon: LayoutDashboard },
  file: { kind: "file", label: "Files", Icon: FileText },
}

/** Fallback glyph for a mention whose `kind` this build doesn't know (written by
 *  a newer build). The node still renders — only the icon degrades. */
export const MENTION_FALLBACK_ICON: LucideIcon = AtSign

export const iconForKind = (kind: unknown): LucideIcon =>
  isMentionKind(kind) ? MENTION_KIND_DEFS[kind].Icon : MENTION_FALLBACK_ICON

const pageByKey = new Map(GLOBAL_NAV.map((g) => [g.key, g] as const))

/**
 * The route for a mention the server did not resolve.
 *
 * Only `page` is resolvable here, and deliberately so: `GLOBAL_NAV` is a static
 * client-side table with no permission dimension, so the server returns a null
 * href for it rather than duplicating a nav table it has no business owning.
 *
 * Every OTHER kind returns null unconditionally. A null href from the server means
 * "unresolvable for this caller" — which is where mention permission enforcement
 * lives — so synthesizing a client-side href for one would hand out a working link
 * to something the caller may not read. There is no case where guessing is right.
 */
export const clientHrefFor = (ref: {
  readonly kind: string
  readonly targetId: string
  readonly href?: string | null
}): string | null => {
  if (ref.href) return ref.href
  if (ref.kind === "page") return pageByKey.get(ref.targetId)?.to ?? null
  return null
}

/** A page mention's live label, for the same reason `clientHrefFor` handles it. */
export const clientLabelFor = (ref: {
  readonly kind: string
  readonly targetId: string
  readonly label?: string | null
}): string | null => {
  if (ref.label) return ref.label
  if (ref.kind === "page") return pageByKey.get(ref.targetId)?.label ?? null
  return null
}
