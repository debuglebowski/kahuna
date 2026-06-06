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
)
export type FieldKind = typeof FieldKind.Type

/** Per-field configuration, stored in `fields.config` (jsonb). */
export interface FieldConfig {
  /** enum: allowed values */
  readonly options?: ReadonlyArray<string>
  /** enum: legal state-machine transitions `from -> [to, ...]` */
  readonly transitions?: Record<string, ReadonlyArray<string>>
  /** relation: the relation type + target concept name */
  readonly relationType?: string
  readonly target?: string
  readonly cardinality?: "one" | "many"
  /** computed: which built-in + its params */
  readonly computedKind?: "decay" | "momentum"
  readonly params?: Record<string, unknown>
}

export type InstanceState = Record<string, unknown>

export interface Concept {
  readonly id: Id
  readonly orgId: OrgId
  readonly name: string
  readonly description: string | null
  readonly createdAt: Date
}

export interface Field {
  readonly id: Id
  readonly orgId: OrgId
  readonly conceptId: Id
  readonly name: string
  readonly kind: FieldKind
  readonly formula: string | null
  readonly config: FieldConfig
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
  readonly relationType: string
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
      readonly relationType: string
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

export type SubjectKind = "instance" | "relation" | "concept" | "field"

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
