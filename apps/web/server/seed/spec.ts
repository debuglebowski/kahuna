import type { FieldConfig, FieldKind } from "@kingsmaker/engine"

export interface FieldSpec {
  readonly name: string
  readonly kind: FieldKind
  readonly config?: FieldConfig
  /** relation fields: the target concept's name, resolved to an id by the runner. */
  readonly targetName?: string
  /** Display glyph: a literal emoji or `lucide:Name` (see engine `Field.icon`). */
  readonly icon?: string
}

export interface ConceptSpec {
  readonly name: string
  readonly description?: string
  /** Display glyph: a literal emoji or `lucide:Name` (see engine `Concept.icon`). */
  readonly icon?: string
  readonly fields: ReadonlyArray<FieldSpec>
}

/**
 * The Kingsmaker application model — a documentation-centric CRM + compliance
 * setup, defined entirely as data over the general engine. The runner folds it
 * into create-concept / add-field calls (event-sourced).
 *
 * Ownership/authorship uses the built-in `user` field kind (a real bauth_user,
 * validated against bauth_member at the app boundary). Inter-concept links are
 * `relation` fields whose `targetName` is resolved to a concept id at seed time:
 *
 *   CompanyContact -works_at->  Company
 *   CompanyNote    -about->     Company
 *   Agreement      -based_on->  AgreementTemplate
 *   Agreement      -for->       Company
 *   Agreement      -signed_by-> CompanyContact
 */
export const kingsmakerSpec: ReadonlyArray<ConceptSpec> = [
  {
    name: "Company",
    description: "A customer or counterparty — the hub of the graph.",
    icon: "🏢",
    fields: [{ name: "name", kind: "text" }],
  },
  {
    name: "CompanyContact",
    description: "A person at a company.",
    icon: "lucide:Contact",
    fields: [
      { name: "name", kind: "text" },
      { name: "email", kind: "text", config: { format: "email" }, icon: "✉️" },
      {
        name: "works_at",
        kind: "relation",
        targetName: "Company",
        config: { cardinality: "one" },
        icon: "🏢",
      },
    ],
  },
  {
    name: "CompanyNote",
    description: "A freeform note about a company.",
    icon: "📝",
    fields: [
      { name: "body", kind: "text" },
      { name: "noted_on", kind: "date", icon: "📅" },
      { name: "author", kind: "user", icon: "👤" },
      {
        name: "about",
        kind: "relation",
        targetName: "Company",
        config: { cardinality: "one" },
      },
    ],
  },
  {
    name: "AgreementTemplate",
    description: "A master template that agreements are executed from.",
    icon: "📋",
    fields: [
      { name: "name", kind: "text" },
      { name: "doc_type", kind: "enum", config: { options: ["msa", "dpa", "nda", "sow"] } },
      {
        name: "status",
        kind: "enum",
        config: {
          options: ["draft", "active", "deprecated"],
          transitions: { draft: ["active"], active: ["deprecated"], deprecated: [] },
        },
      },
      { name: "version", kind: "number" },
      { name: "owner", kind: "user", icon: "👤" },
      { name: "body", kind: "file", icon: "📎" },
    ],
  },
  {
    name: "Agreement",
    description: "An executed agreement — based on a template, for a company.",
    icon: "lucide:FileText",
    fields: [
      { name: "title", kind: "text" },
      {
        name: "status",
        kind: "enum",
        config: {
          options: ["draft", "active", "expired", "terminated"],
          transitions: {
            draft: ["active"],
            active: ["expired", "terminated"],
            expired: [],
            terminated: [],
          },
        },
      },
      { name: "effective_date", kind: "date", icon: "📅" },
      { name: "expiry_date", kind: "date", icon: "📅" },
      { name: "version", kind: "number" },
      { name: "owner", kind: "user", icon: "👤" },
      { name: "file", kind: "file", icon: "📎" },
      {
        name: "based_on",
        kind: "relation",
        targetName: "AgreementTemplate",
        config: { cardinality: "one" },
      },
      {
        name: "for",
        kind: "relation",
        targetName: "Company",
        config: { cardinality: "one" },
      },
      {
        name: "signed_by",
        kind: "relation",
        targetName: "CompanyContact",
        config: { cardinality: "one" },
      },
    ],
  },
  {
    name: "Policy",
    description: "An internal governance policy with a review cadence.",
    icon: "🛡️",
    fields: [
      { name: "title", kind: "text" },
      {
        name: "category",
        kind: "enum",
        config: { options: ["security", "privacy", "hr", "finance"] },
      },
      {
        name: "status",
        kind: "enum",
        config: {
          options: ["draft", "review", "approved", "published", "archived"],
          transitions: {
            draft: ["review"],
            review: ["approved", "draft"],
            approved: ["published"],
            published: ["archived"],
            archived: [],
          },
        },
      },
      { name: "version", kind: "number" },
      { name: "effective_date", kind: "date" },
      { name: "review_due", kind: "date" },
      { name: "owner", kind: "user" },
      { name: "approved_by", kind: "user" },
      { name: "file", kind: "file" },
    ],
  },
  {
    name: "Runbook",
    description: "An internal operational runbook with a review cadence.",
    icon: "lucide:BookOpen",
    fields: [
      { name: "title", kind: "text" },
      {
        name: "category",
        kind: "enum",
        config: { options: ["incident", "onboarding", "deploy", "support"] },
      },
      {
        name: "status",
        kind: "enum",
        config: {
          options: ["draft", "review", "published", "archived"],
          transitions: {
            draft: ["review"],
            review: ["published", "draft"],
            published: ["archived"],
            archived: [],
          },
        },
      },
      { name: "review_due", kind: "date" },
      { name: "owner", kind: "user" },
      { name: "file", kind: "file" },
    ],
  },
]
