import { Either } from "effect"
import type { EngineEvent, RecordState, VersionStatus } from "../domain/types"
import { EventCorruption } from "../errors"

/**
 * The folded state of a record version: its current field values, version, deletion
 * marker, and product-version status. Reconstructable purely from the event
 * stream.
 *
 * Note: `versionStatus`/`publishedAt` are folded here because they change over an
 * record version's life (a draft is published). The immutable lineage facts
 * (`recordId`/`versionSeq`) are NOT folded — they are set once at insert and
 * preserved verbatim by the rebuild write-back, so legacy events (which lack the
 * payload metadata) still reconstruct correctly.
 */
export interface FoldState {
  readonly state: RecordState
  readonly version: number
  readonly archivedAt: Date | null
  readonly versionStatus: VersionStatus
  readonly publishedAt: Date | null
}

/** An explicit `null` field value means "clear" — the key is dropped from the
 *  projected state rather than stored. Replay-safe: nulls only entered payloads
 *  once validation started accepting them, and they fold to the same deletion. */
const dropNulls = (state: Record<string, unknown>): RecordState => {
  for (const [k, v] of Object.entries(state)) if (v === null) delete state[k]
  return state
}

/**
 * THE pure reducer — the single place record version state is computed. Both the
 * incremental write path (RecordService) and the rebuild/time-travel path
 * route through this exact function, which is what makes the
 * "replay == incremental projection" invariant true by construction.
 *
 * Convention: `version` starts at 0 on create and increments by 1 per
 * subsequent mutating event (so version === number-of-events − 1).
 */
export const applyEvent = (
  acc: FoldState | null,
  event: EngineEvent,
): Either.Either<FoldState, EventCorruption> => {
  const p = event.payload

  if (p._tag === "RecordVersionCreated") {
    if (acc !== null) {
      return Either.left(
        new EventCorruption({
          reason: "create event after recordVersion exists",
          eventId: event.id,
        }),
      )
    }
    // Legacy events lack version metadata ⇒ default to a published seq-1 row, so
    // pre-versioning record versions replay unchanged.
    const versionStatus = p.versionStatus ?? "published"
    return Either.right({
      state: dropNulls({ ...p.fields }),
      version: 0,
      archivedAt: null,
      versionStatus,
      publishedAt: versionStatus === "published" ? event.occurredAt : null,
    })
  }

  if (acc === null) {
    return Either.left(
      new EventCorruption({ reason: "mutation event before create", eventId: event.id }),
    )
  }

  // Un-archive: the only event legal on an already-archived record version. Handled
  // before the guard below so an archived → restored → … lifecycle replays.
  if (p._tag === "RecordVersionRestored") {
    if (acc.archivedAt === null) {
      return Either.left(
        new EventCorruption({ reason: "restore on a live recordVersion", eventId: event.id }),
      )
    }
    return Either.right({
      state: acc.state,
      version: acc.version + 1,
      archivedAt: null,
      versionStatus: acc.versionStatus,
      publishedAt: acc.publishedAt,
    })
  }
  if (acc.archivedAt !== null) {
    return Either.left(
      new EventCorruption({
        reason: "event after archive (only restore is legal)",
        eventId: event.id,
      }),
    )
  }

  switch (p._tag) {
    // `VersionAmended` is an edit to an already-published version (a concept with
    // `editReach: "any"`). It folds IDENTICALLY to an ordinary edit — the separate
    // tag exists only so the activity feed can distinguish the two.
    case "VersionAmended":
    case "RecordVersionUpdated":
      // NB: WHICH versions may be edited is enforced in RecordService (which knows
      // `versioningEnabled` + `editReach`) — NOT here, because a non-versioned
      // record version is also 'published' yet must stay editable.
      return Either.right({
        state: dropNulls({ ...acc.state, ...p.patch }),
        version: acc.version + 1,
        archivedAt: null,
        versionStatus: acc.versionStatus,
        publishedAt: acc.publishedAt,
      })
    // Draft → published. One-shot: a second publish is corruption. Only ever
    // emitted for versioned concepts, so it can't misfire on a non-versioned row.
    case "VersionPublished":
      if (acc.versionStatus === "published") {
        return Either.left(
          new EventCorruption({
            reason: "publish on an already-published version",
            eventId: event.id,
          }),
        )
      }
      return Either.right({
        state: acc.state,
        version: acc.version + 1,
        archivedAt: acc.archivedAt,
        versionStatus: "published",
        publishedAt: event.occurredAt,
      })
    // `RecordVersionDeleted` is the legacy archive tag (kept for replay); new archives
    // emit `RecordVersionArchived`. Both mark the record version archived identically.
    case "RecordVersionDeleted":
    case "RecordVersionArchived":
      return Either.right({
        state: acc.state,
        version: acc.version + 1,
        archivedAt: event.occurredAt,
        versionStatus: acc.versionStatus,
        publishedAt: acc.publishedAt,
      })
    case "AttachmentAdded":
      // Attachments are recorded against the record version but do not change its
      // projected state or version.
      return Either.right(acc)
    case "ComputedBandChanged": {
      // Materialise a coarse band marker for change-detection / automations.
      // Does NOT bump version (the display decay/momentum stay computed-on-read).
      const bands = (acc.state.__bands as Record<string, string> | undefined) ?? {}
      return Either.right({
        state: { ...acc.state, __bands: { ...bands, [p.field]: p.to } },
        version: acc.version,
        archivedAt: acc.archivedAt,
        versionStatus: acc.versionStatus,
        publishedAt: acc.publishedAt,
      })
    }
    default:
      // Non-record version payloads should never appear in a record version stream.
      return Either.left(
        new EventCorruption({
          reason: `unexpected payload ${p._tag} in recordVersion stream`,
          eventId: event.id,
        }),
      )
  }
}
