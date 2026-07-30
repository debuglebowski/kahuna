/**
 * Whose data may be written — the client mirror of the engine's version freeze.
 *
 * `app/src/` imports zero engine modules (types are hand-mirrored through
 * `rpc/contract.ts`), so this duplicates `packages/engine/src/domain/versioning.ts`
 * on purpose. Keep the two in step: the server is authoritative and answers
 * `VersionFrozen` on a mismatch, so drift shows up as a UI that offers an edit the
 * API then refuses.
 */

import type { Concept, Instance } from "./api"

/**
 * May this version's fields and links be edited? Three ways to be editable:
 *  - the concept isn't versioned at all (every instance is a plain editable row —
 *    note such rows are `published` too, which is why the status alone won't do);
 *  - it's the open draft;
 *  - the concept allows amending published versions (`editReach: "any"`).
 *
 * Takes the loosest possible shapes so callers can pass a partially-loaded
 * concept (`conceptById.get(...)`, which may miss) without ceremony.
 */
export const canEditVersion = (
  concept: Pick<Concept, "versioningEnabled" | "editReach"> | null | undefined,
  instance: Pick<Instance, "versionStatus"> | null | undefined,
): boolean => {
  // Nothing loaded yet ⇒ don't claim frozen; the server is the real gate, and
  // guessing "frozen" would flicker the UI read-only on every load.
  if (!concept || !instance) return true
  return (
    !concept.versioningEnabled || instance.versionStatus === "draft" || concept.editReach === "any"
  )
}

/** May a PUBLISHED version of this concept be edited? For callers holding only a
 *  concept, where the version's status is known to be published by construction —
 *  e.g. an inbound relation's source (drafts never surface as inbound references). */
export const canEditPublished = (
  concept: Pick<Concept, "versioningEnabled" | "editReach"> | null | undefined,
): boolean => canEditVersion(concept, { versionStatus: "published" })

/** Is the user editing an ALREADY-PUBLISHED version? Drives the warning banner:
 *  such an edit is live to everyone referencing that version. Only ever true when
 *  {@link canEditVersion} is too (a frozen version isn't being edited at all). */
export const isAmending = (
  concept: Pick<Concept, "versioningEnabled" | "editReach"> | null | undefined,
  instance: Pick<Instance, "versionStatus"> | null | undefined,
): boolean =>
  !!concept?.versioningEnabled &&
  instance?.versionStatus === "published" &&
  concept.editReach === "any"
