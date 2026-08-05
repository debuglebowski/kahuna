import { Effect } from "effect"
import { FieldValidationError } from "../errors"
import type { FieldConfig, FieldKind } from "./types"

/**
 * A scalar field validator, factored to work over any `{ name, kind, config }`
 * shape (a concept `Field` or an annotation `AnnotationField`). It mirrors the
 * private validator in `RecordService` but is restricted to SCALAR kinds —
 * relation/computed/file are rejected, since the annotation custom-field bag
 * only ever holds scalars. Kept dependency-free so both layers validate identically.
 */

export interface ScalarDef {
  readonly name: string
  readonly kind: FieldKind
  readonly config: FieldConfig
}

const TEXT_FORMATS: Record<string, (v: string) => boolean> = {
  email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
  url: (v) => /^https?:\/\/\S+$/.test(v),
  phone: (v) => /^\+?[0-9][0-9 ().-]{4,}$/.test(v),
  slug: (v) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v),
  color: (v) => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v),
}
const NUMBER_FORMATS: Record<string, (v: number) => boolean> = {
  percent: (v) => v >= 0 && v <= 100,
}

const isMoney = (v: unknown): v is { readonly amount: number; readonly currency: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { amount?: unknown }).amount === "number" &&
  Number.isFinite((v as { amount: number }).amount) &&
  typeof (v as { currency?: unknown }).currency === "string" &&
  /^[A-Z]{3}$/.test((v as { currency: string }).currency)

/** Validate a single (non-array) value against a scalar def. */
const validateScalar = (
  def: ScalarDef,
  value: unknown,
): Effect.Effect<unknown, FieldValidationError> => {
  const fail = (message: string) =>
    Effect.fail(new FieldValidationError({ message, field: def.name }))
  switch (def.kind) {
    case "text": {
      if (typeof value !== "string") return fail(`field "${def.name}" expects text`)
      const fmt = def.config.format
      if (fmt && TEXT_FORMATS[fmt] && !TEXT_FORMATS[fmt](value))
        return fail(`field "${def.name}" must be a valid ${fmt}`)
      return Effect.succeed(value)
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return fail(`field "${def.name}" expects a number`)
      const fmt = def.config.format
      if (fmt && NUMBER_FORMATS[fmt] && !NUMBER_FORMATS[fmt](value))
        return fail(`field "${def.name}" must be a valid ${fmt}`)
      return Effect.succeed(value)
    }
    case "bool":
      return typeof value === "boolean"
        ? Effect.succeed(value)
        : fail(`field "${def.name}" expects a boolean`)
    case "date":
      if (value instanceof Date) return Effect.succeed(value.toISOString())
      return typeof value === "string" && !Number.isNaN(Date.parse(value))
        ? Effect.succeed(value)
        : fail(`field "${def.name}" expects an ISO date`)
    case "enum":
      return typeof value === "string" && (def.config.options ?? []).includes(value)
        ? Effect.succeed(value)
        : fail(`field "${def.name}" must be one of ${(def.config.options ?? []).join(", ")}`)
    case "user":
      return typeof value === "string" && value.length > 0
        ? Effect.succeed(value)
        : fail(`field "${def.name}" expects a user id`)
    case "json":
      return value !== undefined
        ? Effect.succeed(value)
        : fail(`field "${def.name}" expects a value`)
    case "money":
      return isMoney(value)
        ? Effect.succeed({ amount: value.amount, currency: value.currency })
        : fail(`field "${def.name}" expects { amount, currency }`)
    case "relation":
    case "file":
    case "computed":
    // richtext is record version-only — AnnotationFieldService's allowlist excludes it.
    case "richtext":
      return fail(`field "${def.name}" kind "${def.kind}" is not allowed as a custom field`)
  }
}

/** Validate a value, fanning out over the array when `config.multiple`. */
export const validateScalarValue = (
  def: ScalarDef,
  value: unknown,
): Effect.Effect<unknown, FieldValidationError> => {
  if (def.config.multiple) {
    if (!Array.isArray(value))
      return Effect.fail(
        new FieldValidationError({
          message: `field "${def.name}" expects a list`,
          field: def.name,
        }),
      )
    return Effect.forEach(value, (v) => validateScalar(def, v))
  }
  return validateScalar(def, value)
}

/**
 * Validate a custom-fields bag against its definitions, keyed by definition id.
 * Unknown keys fail. Returns the (coerced) validated record.
 */
export const validateCustomFields = (
  defs: ReadonlyArray<ScalarDef & { readonly id: string }>,
  input: Record<string, unknown>,
): Effect.Effect<Record<string, unknown>, FieldValidationError> =>
  Effect.gen(function* () {
    const byId = new Map(defs.map((d) => [d.id, d]))
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      const def = byId.get(key)
      if (!def)
        return yield* Effect.fail(
          new FieldValidationError({ message: `unknown custom field "${key}"`, field: key }),
        )
      out[key] = yield* validateScalarValue(def, value)
    }
    return out
  })
