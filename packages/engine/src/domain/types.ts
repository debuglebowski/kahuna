import { Schema } from "effect"

/**
 * Lightweight id aliases. (Branded ids were considered but add constant
 * brand/unbrand friction against raw SQL strings; v1 keeps them as plain
 * strings. Anti-drift is enforced via field validation + state machines +
 * typed errors instead.)
 */
export type Id = string
export type OrgId = string
export type Actor = string

export const FieldKind = Schema.Literal(
  "text",
  "number",
  "date",
  "bool",
  "enum",
  "relation",
  "file",
  "computed",
  // refs a real org member (bauth_user.id); stored in state like a scalar.
  "user",
  // arbitrary JSON-serializable blob (escape hatch for unmodeled data).
  "json",
  // an { amount, currency } pair.
  "money",
)
export type FieldKind = typeof FieldKind.Type

/** Per-field configuration, stored in `fields.config` (jsonb). */
export interface FieldConfig {
  /** enum: allowed values */
  readonly options?: ReadonlyArray<string>
  /** enum: legal state-machine transitions `from -> [to, ...]` */
  readonly transitions?: Record<string, ReadonlyArray<string>>
  /** relation: the target concept's id (the relation's identity is its field id). */
  readonly target?: string
  readonly cardinality?: "one" | "many"
  /** computed: which built-in + its params */
  readonly computedKind?: "decay" | "momentum"
  readonly params?: Record<string, unknown>
  /** any scalar kind: store/validate an array of values instead of a single one. */
  readonly multiple?: boolean
  /** text/number: an extra format constraint (email/url/phone/slug/color | percent). */
  readonly format?: string
}

/** Instance field values, keyed by field **id** (`fields.id`). Synthetic keys
 *  prefixed with `__` (e.g. `__bands`, `__labels`) are engine markers, not fields.
 *  `__labels` holds this item's own label ids (an array of `labels.id`); it rides
 *  the normal InstanceCreated/InstanceUpdated payloads and folds like any state key. */
export type InstanceState = Record<string, unknown>

/** Synthetic `InstanceState` key holding an instance's own label ids. */
export const LABELS_KEY = "__labels"

export interface Concept {
  readonly id: Id
  readonly orgId: OrgId
  /** Stable, immutable system key (derived from the initial name). Code that must
   *  pin a specific concept (dashboards, computed scans) refers to this, never the
   *  display name — so the name is free to be renamed. */
  readonly slug: string
  readonly name: string
  /** Optional plural display label (e.g. `name` "Company" → "Companies"). The
   *  sidebar prefers it and falls back to `name`; null until set (creation only
   *  asks for the singular). */
  readonly pluralName: string | null
  readonly description: string | null
  /** Optional display glyph: a literal emoji or a curated lucide icon name
   *  prefixed `lucide:` (e.g. `lucide:Building2`); null renders none. */
  readonly icon: string | null
  /** Label ids inherited by every instance of this concept (read-time, never
   *  written per item — so they can't be removed on an individual item). */
  readonly staticLabelIds: ReadonlyArray<Id>
  /** Label ids snapshotted onto each new instance's `__labels` at creation time;
   *  editable per item afterward. */
  readonly defaultLabelIds: ReadonlyArray<Id>
  readonly createdAt: Date
}

/** A label in the org-wide, flat vocabulary. Keyed by `id`; `name`/`color` are
 *  freely editable; soft-deleted so any id it ever owned stays resolvable. */
export interface Label {
  readonly id: Id
  readonly orgId: OrgId
  readonly name: string
  /** Optional free hex color (e.g. "#e11d48"); null renders neutral. */
  readonly color: string | null
  /** A plain flag for now (rendered with a crown); future features key off it. */
  readonly primary: boolean
  readonly createdAt: Date
  readonly deletedAt: Date | null
}

/** Identify a concept by exactly one handle (compile-time exclusive). */
export type ConceptRef = { readonly conceptId: string } | { readonly conceptName: string }

export interface Field {
  readonly id: Id
  readonly orgId: OrgId
  readonly conceptId: Id
  /** Decorative, freely-renameable label. The stable key is `id`. */
  readonly name: string
  readonly kind: FieldKind
  readonly formula: string | null
  readonly config: FieldConfig
  /** Optional display glyph (see `Concept.icon`): literal emoji or `lucide:Name`. */
  readonly icon: string | null
  /** Soft-delete marker; non-null fields are hidden from `listFields` but stay
   *  resolvable by `id` (so orphaned state keys / historical edges resolve). */
  readonly deletedAt: Date | null
}

export interface Instance {
  readonly id: Id
  readonly orgId: OrgId
  readonly conceptId: Id
  readonly state: InstanceState
  readonly version: number
  readonly createdAt: Date
  readonly deletedAt: Date | null
}

export interface Relation {
  readonly id: Id
  readonly orgId: OrgId
  /** The relation field def (kind=relation) this edge realises. */
  readonly fieldId: Id
  readonly fromId: Id
  readonly toId: Id
  readonly properties: Record<string, unknown>
  readonly createdAt: Date
  readonly deletedAt: Date | null
}

export type EventPayload =
  | { readonly _tag: "InstanceCreated"; readonly conceptId: Id; readonly fields: InstanceState }
  | { readonly _tag: "InstanceUpdated"; readonly patch: InstanceState }
  | { readonly _tag: "InstanceDeleted" }
  | {
      readonly _tag: "RelationCreated"
      readonly fieldId: Id
      readonly fromId: Id
      readonly toId: Id
      readonly properties: Record<string, unknown>
    }
  | { readonly _tag: "RelationDeleted"; readonly relationId: Id }
  | { readonly _tag: "AttachmentAdded"; readonly attachmentId: Id; readonly filename: string }
  | { readonly _tag: "ConceptCreated"; readonly name: string }
  | {
      readonly _tag: "FieldAdded"
      readonly conceptId: Id
      readonly name: string
      readonly kind: string
    }
  // Emitted by the server decay tick when a time-derived computed band crosses a
  // threshold (e.g. decay warm -> cooling). Folds into a `__bands` marker WITHOUT
  // bumping version (like AttachmentAdded), so it never collides with a user's
  // optimistic-concurrency check.
  | {
      readonly _tag: "ComputedBandChanged"
      readonly field: string
      readonly kind: "decay" | "momentum"
      readonly from: string | null
      readonly to: string
    }
  // Concept/field schema edits (settings → concept configuration). These are
  // subjectKind "concept"/"field" events — they NEVER appear in an instance
  // stream, so the instance reducer (projection/reducer.ts) ignores them.
  | {
      readonly _tag: "ConceptUpdated"
      readonly description: string | null
      readonly name?: string
      readonly pluralName?: string | null
      readonly icon?: string | null
      readonly staticLabelIds?: ReadonlyArray<Id>
      readonly defaultLabelIds?: ReadonlyArray<Id>
    }
  | { readonly _tag: "ConceptDeleted" }
  // Label vocabulary edits (settings → Labels). subjectKind "label"; like
  // concept/field schema events these never appear in an instance stream.
  | {
      readonly _tag: "LabelCreated"
      readonly name: string
      readonly color: string | null
      readonly primary: boolean
    }
  | {
      readonly _tag: "LabelRenamed"
      readonly name: string
      readonly color: string | null
      readonly primary: boolean
    }
  | { readonly _tag: "LabelDeleted" }
  | {
      readonly _tag: "FieldUpdated"
      readonly conceptId: Id
      readonly name: string
      readonly kind: string
    }
  | { readonly _tag: "FieldDeleted"; readonly conceptId: Id; readonly name: string }

export interface Attachment {
  readonly id: Id
  readonly orgId: OrgId
  readonly instanceId: Id
  readonly filename: string
  readonly contentRef: string
  readonly mimeType: string | null
  readonly sizeBytes: number | null
  readonly createdAt: Date
}

export type SubjectKind = "instance" | "relation" | "concept" | "field" | "label"

export interface EngineEvent {
  readonly id: number
  readonly orgId: OrgId
  readonly occurredAt: Date
  readonly actor: string | null
  readonly subjectKind: SubjectKind
  readonly subjectId: Id
  readonly eventType: string
  readonly payload: EventPayload
}
