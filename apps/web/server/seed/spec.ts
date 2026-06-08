import type { FieldConfig, FieldKind } from "@kingsmaker/engine"

export interface FieldSpec {
  readonly name: string
  readonly kind: FieldKind
  readonly config?: FieldConfig
  /** relation fields: the target concept's name, resolved to an id by the runner. */
  readonly targetName?: string
}

export interface ConceptSpec {
  readonly name: string
  readonly description?: string
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
 *   AccountContact -works_at->  Account
 *   AccountNote    -about->     Account
 *   Agreement      -based_on->  AgreementTemplate
 *   Agreement      -for->       Account
 *   Agreement      -signed_by-> AccountContact
 */
export const kingsmakerSpec: ReadonlyArray<ConceptSpec> = [
  {
    name: "Account",
    description: "A customer or counterparty — the hub of the graph.",
    fields: [{ name: "name", kind: "text" }],
  },
  {
    name: "AccountContact",
    description: "A person at an account.",
    fields: [
      { name: "name", kind: "text" },
      { name: "email", kind: "text", config: { format: "email" } },
      {
        name: "works_at",
        kind: "relation",
        targetName: "Account",
        config: { relationType: "works_at", cardinality: "one" },
      },
    ],
  },
  {
    name: "AccountNote",
    description: "A freeform note about an account.",
    fields: [
      { name: "body", kind: "text" },
      { name: "noted_on", kind: "date" },
      { name: "author", kind: "user" },
      {
        name: "about",
        kind: "relation",
        targetName: "Account",
        config: { relationType: "about", cardinality: "one" },
      },
    ],
  },
  {
    name: "AgreementTemplate",
    description: "A master template that agreements are executed from.",
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
      { name: "owner", kind: "user" },
      { name: "body", kind: "file" },
    ],
  },
  {
    name: "Agreement",
    description: "An executed agreement — based on a template, for an account.",
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
      { name: "effective_date", kind: "date" },
      { name: "expiry_date", kind: "date" },
      { name: "version", kind: "number" },
      { name: "owner", kind: "user" },
      { name: "file", kind: "file" },
      {
        name: "based_on",
        kind: "relation",
        targetName: "AgreementTemplate",
        config: { relationType: "based_on", cardinality: "one" },
      },
      {
        name: "for",
        kind: "relation",
        targetName: "Account",
        config: { relationType: "for", cardinality: "one" },
      },
      {
        name: "signed_by",
        kind: "relation",
        targetName: "AccountContact",
        config: { relationType: "signed_by", cardinality: "one" },
      },
    ],
  },
  {
    name: "Policy",
    description: "An internal governance policy with a review cadence.",
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
