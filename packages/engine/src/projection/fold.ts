import { Either } from "effect"
import type { EngineEvent } from "../domain/types"
import type { EventCorruption } from "../errors"
import { applyEvent, type FoldState } from "./reducer"

/** Fold an ordered event stream into the current state (null if no events). */
export const foldEvents = (
  events: ReadonlyArray<EngineEvent>,
): Either.Either<FoldState | null, EventCorruption> => {
  let acc: FoldState | null = null
  for (const event of events) {
    const next = applyEvent(acc, event)
    if (Either.isLeft(next)) return next
    acc = next.right
  }
  return Either.right(acc)
}

/** Time-travel: fold only the events up to and including `eventId`. */
export const foldUntil = (
  events: ReadonlyArray<EngineEvent>,
  eventId: number,
): Either.Either<FoldState | null, EventCorruption> =>
  foldEvents(events.filter((e) => e.id <= eventId))
