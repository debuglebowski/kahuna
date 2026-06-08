/** Generate a unique, URL-safe org slug from a display name.
 *
 * BetterAuth requires every org to have a non-empty, unique `slug`, but we never
 * expose it in the UI — it's auto-generated here from the name with a short
 * random suffix for uniqueness. Used by sign-up and the create-org dialog. */
export function makeOrgSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const suffix = Math.random().toString(36).slice(2, 7)
  return `${base || "org"}-${suffix}`
}
