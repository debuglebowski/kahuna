import { Either } from "effect"
import type { EngineEvent, InstanceState } from "../domain/types"
import { EventCorruption } from "../errors"

/**
 * The folded state of an instance: its current field values, version, and
 * deletion marker. Reconstructable purely from the event stream.
 */
export interface FoldState {
  readonly state: InstanceState
  readonly version: number
  readonly deletedAt: Date | null
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
    return Either.right({ state: { ...p.fields }, version: 0, deletedAt: null })
  }

  if (acc === null) {
    return Either.left(
      new EventCorruption({ reason: "mutation event before create", eventId: event.id }),
    )
  }
  if (acc.deletedAt !== null) {
    return Either.left(
      new EventCorruption({ reason: "event after delete (no undelete in v1)", eventId: event.id }),
    )
  }

  switch (p._tag) {
    case "InstanceUpdated":
      return Either.right({
        state: { ...acc.state, ...p.patch },
        version: acc.version + 1,
        deletedAt: null,
      })
    case "InstanceDeleted":
      return Either.right({
        state: acc.state,
        version: acc.version + 1,
        deletedAt: event.occurredAt,
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
        deletedAt: acc.deletedAt,
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
