import { Either } from "effect"
import type { EngineEvent, InstanceState, VersionStatus } from "../domain/types"
import { EventCorruption } from "../errors"

/**
 * The folded state of an instance: its current field values, version, deletion
 * marker, and product-version status. Reconstructable purely from the event
 * stream.
 *
 * Note: `versionStatus`/`publishedAt` are folded here because they change over an
 * instance's life (a draft is published). The immutable lineage facts
 * (`itemId`/`versionSeq`) are NOT folded — they are set once at insert and
 * preserved verbatim by the rebuild write-back, so legacy events (which lack the
 * payload metadata) still reconstruct correctly.
 */
export interface FoldState {
  readonly state: InstanceState
  readonly version: number
  readonly archivedAt: Date | null
  readonly versionStatus: VersionStatus
  readonly publishedAt: Date | null
}

/** An explicit `null` field value means "clear" — the key is dropped from the
 *  projected state rather than stored. Replay-safe: nulls only entered payloads
 *  once validation started accepting them, and they fold to the same deletion. */
const dropNulls = (state: Record<string, unknown>): InstanceState => {
  for (const [k, v] of Object.entries(state)) if (v === null) delete state[k]
  return state
}

/**
 * THE pure reducer — the single place instance state is computed. Both the
 * incremental write path (InstanceService) and the rebuild/time-travel path
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

  if (p._tag === "InstanceCreated") {
    if (acc !== null) {
      return Either.left(
        new EventCorruption({ reason: "create event after instance exists", eventId: event.id }),
      )
    }
    // Legacy events lack version metadata ⇒ default to a published seq-1 row, so
    // pre-versioning instances replay unchanged.
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

  // Un-archive: the only event legal on an already-archived instance. Handled
  // before the guard below so an archived → restored → … lifecycle replays.
  if (p._tag === "InstanceRestored") {
    if (acc.archivedAt === null) {
      return Either.left(
        new EventCorruption({ reason: "restore on a live instance", eventId: event.id }),
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
    case "InstanceUpdated":
      // NB: WHICH versions may be edited is enforced in InstanceService (which knows
      // `versioningEnabled` + `editReach`) — NOT here, because a non-versioned
      // instance is also 'published' yet must stay editable.
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
    // `InstanceDeleted` is the legacy archive tag (kept for replay); new archives
    // emit `InstanceArchived`. Both mark the instance archived identically.
    case "InstanceDeleted":
    case "InstanceArchived":
      return Either.right({
        state: acc.state,
        version: acc.version + 1,
        archivedAt: event.occurredAt,
        versionStatus: acc.versionStatus,
        publishedAt: acc.publishedAt,
      })
    case "AttachmentAdded":
      // Attachments are recorded against the instance but do not change its
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
      // Non-instance payloads should never appear in an instance stream.
      return Either.left(
        new EventCorruption({
          reason: `unexpected payload ${p._tag} in instance stream`,
          eventId: event.id,
        }),
      )
  }
}
