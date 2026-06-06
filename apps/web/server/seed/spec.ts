import type { FieldConfig, FieldKind } from "@kingsmaker/engine"

export interface FieldSpec {
  readonly name: string
  readonly kind: FieldKind
  readonly config?: FieldConfig
}

export interface ConceptSpec {
  readonly name: string
  readonly description?: string
  readonly fields: ReadonlyArray<FieldSpec>
}

const computedParams: FieldConfig["params"] = {
  forRelation: "for",
  onRelation: "on",
  dateField: "occurred_on",
}

/**
 * The Kingsmaker application — defined entirely as data over the general engine.
 * The runner folds this into create-concept / add-field calls (event-sourced).
 *
 * Relation types used by the app (created via RelationService at runtime, not
 * declared as fields so a type can target multiple concepts):
 *   Contact -works_at-> Account, Contact -reports_to-> Contact,
 *   TeamMember -owns-> Account|Task, Interaction -on-> Account,
 *   Interaction -with-> Contact, Signal -from-> Account,
 *   Artifact -belongs_to-> Account, Deal -for-> Account, Task -on-> Account|Deal.
 */
export const kingsmakerSpec: ReadonlyArray<ConceptSpec> = [
  {
    name: "Account",
    description: "A customer or prospect — the hub of the graph.",
    fields: [
      { name: "name", kind: "text" },
      {
        name: "lifecycle_phase",
        kind: "enum",
        config: { options: ["prospect", "deal", "live", "renewal"] },
      },
      { name: "prospecting_value", kind: "number" },
      { name: "contract_value", kind: "number" },
      { name: "intel", kind: "text" },
    ],
  },
  {
    name: "Contact",
    description: "A person at an account.",
    fields: [
      { name: "name", kind: "text" },
      { name: "email", kind: "text" },
      {
        name: "role",
        kind: "enum",
        config: { options: ["champion", "economic_buyer", "blocker", "user"] },
      },
    ],
  },
  {
    name: "TeamMember",
    description: "An internal owner (links to a Tier-0 user).",
    fields: [
      { name: "name", kind: "text" },
      { name: "user_ref", kind: "text" },
    ],
  },
  {
    name: "Deal",
    description: "An opportunity moving through an enforced lifecycle.",
    fields: [
      {
        name: "status",
        kind: "enum",
        config: {
          options: ["lead", "qualified", "proposal", "negotiation", "won", "lost"],
          transitions: {
            lead: ["qualified", "lost"],
            qualified: ["proposal", "lost"],
            proposal: ["negotiation", "lost"],
            negotiation: ["won", "lost"],
            won: [],
            lost: [],
          },
        },
      },
      { name: "blocker", kind: "text" },
      { name: "next_touchpoint", kind: "date" },
      { name: "is_renewal", kind: "bool" },
      {
        name: "momentum",
        kind: "computed",
        config: { computedKind: "momentum", params: computedParams },
      },
      {
        name: "decay",
        kind: "computed",
        config: { computedKind: "decay", params: computedParams },
      },
    ],
  },
  {
    name: "Interaction",
    description: "A logged touchpoint.",
    fields: [
      { name: "occurred_on", kind: "date" },
      { name: "kind", kind: "enum", config: { options: ["call", "email", "meeting", "note"] } },
      { name: "note", kind: "text" },
    ],
  },
  {
    name: "Signal",
    description: "A typed demand/risk signal raised from an account.",
    fields: [
      { name: "kind", kind: "enum", config: { options: ["request", "risk", "renewal"] } },
      { name: "description", kind: "text" },
      {
        name: "status",
        kind: "enum",
        config: {
          options: ["captured", "promoted", "shipped"],
          transitions: { captured: ["promoted"], promoted: ["shipped"], shipped: [] },
        },
      },
      { name: "linear_issue", kind: "text" },
    ],
  },
  {
    name: "Artifact",
    description: "A typed document with a file attachment.",
    fields: [
      {
        name: "doc_type",
        kind: "enum",
        config: { options: ["contract", "dpa", "sow", "questionnaire"] },
      },
      { name: "effective_date", kind: "date" },
      { name: "expiry_date", kind: "date" },
      { name: "version", kind: "text" },
      { name: "status", kind: "enum", config: { options: ["draft", "active", "expired"] } },
    ],
  },
  {
    name: "Task",
    description: "A unit of follow-up work.",
    fields: [
      { name: "title", kind: "text" },
      { name: "due_date", kind: "date" },
      { name: "done", kind: "bool" },
    ],
  },
]

export const relationTypes = [
  "works_at",
  "reports_to",
  "owns",
  "on",
  "with",
  "from",
  "belongs_to",
  "for",
] as const
