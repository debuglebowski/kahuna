import type { EditReach, VersionStatus } from "./types"

/**
 * May this version's data be written? The single source of truth for the freeze,
 * shared by the instance guard and the relation source guard so the two can't
 * drift. Pure (no db) so it also documents the rule in one readable place.
 *
 * Three ways to be editable:
 *  - the concept isn't versioned at all (every instance is a plain editable row —
 *    note such rows are `published` too, which is why the status alone won't do);
 *  - it's the open draft;
 *  - the concept allows amending published versions (`editReach: "any"`).
 *
 * The web client mirrors this in `apps/web/src/lib/editability.ts` (it can't
 * import the engine); keep the two in step.
 */
export const canEditVersion = (
  concept: { readonly versioningEnabled: boolean; readonly editReach: EditReach },
  instance: { readonly versionStatus: VersionStatus },
): boolean =>
  !concept.versioningEnabled || instance.versionStatus === "draft" || concept.editReach === "any"

/** Is this write an AMENDMENT (an edit to an already-published version) rather
 *  than an ordinary edit? Decides `VersionAmended` vs `InstanceUpdated`. Assumes
 *  the write is already permitted — check {@link canEditVersion} first. */
export const isAmendment = (
  concept: { readonly versioningEnabled: boolean },
  instance: { readonly versionStatus: VersionStatus },
): boolean => concept.versioningEnabled && instance.versionStatus === "published"
