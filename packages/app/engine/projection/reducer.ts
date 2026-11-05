import { Result } from "effect"
import {
  EMPTY_RELEASE,
  type EngineEvent,
  type RecordState,
  type ReleaseInfo,
  type VersionRelease,
  type VersionStatus,
} from "../domain/types"
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
  /** Release metadata (name / note / approval), folded from the version's
   *  publish + approval + info events. */
  readonly release: VersionRelease
}

/** Overlay the release-text keys PRESENT in `info` (explicit null clears). */
const withInfo = (r: VersionRelease, info: ReleaseInfo): VersionRelease => ({
  ...r,
  ...(info.name !== undefined ? { name: info.name } : {}),
  ...(info.note !== undefined ? { note: info.note } : {}),
  ...(info.effectiveDate !== undefined ? { effectiveDate: info.effectiveDate } : {}),
})

const infoOf = (p: ReleaseInfo): ReleaseInfo => ({
  name: p.name,
  note: p.note,
  effectiveDate: p.effectiveDate,
})

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
): Result.Result<FoldState, EventCorruption> => {
  const p = event.payload

  if (p._tag === "RecordVersionCreated") {
    if (acc !== null) {
      return Result.fail(
        new EventCorruption({
          reason: "create event after recordVersion exists",
          eventId: event.id,
        }),
      )
    }
    // Legacy events lack version metadata ⇒ default to a published seq-1 row, so
    // pre-versioning record versions replay unchanged.
    const versionStatus = p.versionStatus ?? "published"
    return Result.succeed({
      state: dropNulls({ ...p.fields }),
      version: 0,
      archivedAt: null,
      versionStatus,
      publishedAt: versionStatus === "published" ? event.occurredAt : null,
      release: p.historical ? { ...EMPTY_RELEASE, historical: true } : EMPTY_RELEASE,
    })
  }

  if (acc === null) {
    return Result.fail(
      new EventCorruption({ reason: "mutation event before create", eventId: event.id }),
    )
  }

  // Un-archive: the only event legal on an already-archived record version. Handled
  // before the guard below so an archived → restored → … lifecycle replays.
  if (p._tag === "RecordVersionRestored") {
    if (acc.archivedAt === null) {
      return Result.fail(
        new EventCorruption({ reason: "restore on a live recordVersion", eventId: event.id }),
      )
    }
    return Result.succeed({ ...acc, version: acc.version + 1, archivedAt: null })
  }
  if (acc.archivedAt !== null) {
    return Result.fail(
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
      return Result.succeed({
        ...acc,
        state: dropNulls({ ...acc.state, ...p.patch }),
        version: acc.version + 1,
        archivedAt: null,
      })
    // Draft → published. One-shot: a second publish is corruption. Only ever
    // emitted for versioned concepts, so it can't misfire on a non-versioned row.
    case "VersionPublished": {
      if (acc.versionStatus === "published") {
        return Result.fail(
          new EventCorruption({
            reason: "publish on an already-published version",
            eventId: event.id,
          }),
        )
      }
      // An approved publish carries the request's text; the AUTHOR is whoever
      // requested it (the approver's actor is on `VersionApproved`). A direct
      // publish's author is its own actor.
      const pending = acc.release.pending
      const release = withInfo(acc.release, infoOf(p))
      return Result.succeed({
        ...acc,
        version: acc.version + 1,
        versionStatus: "published",
        publishedAt: event.occurredAt,
        release: {
          ...release,
          publishedBy: pending ? pending.requestedBy : event.actor,
          pending: null,
          lastRejection: null,
        },
      })
    }
    case "VersionApprovalRequested":
      if (acc.versionStatus === "published" || acc.release.pending) {
        return Result.fail(
          new EventCorruption({
            reason: "approval request on a published or already-pending version",
            eventId: event.id,
          }),
        )
      }
      return Result.succeed({
        ...acc,
        version: acc.version + 1,
        release: {
          ...acc.release,
          pending: {
            approverId: p.approverId,
            requestedBy: event.actor,
            requestedAt: event.occurredAt.toISOString(),
            name: p.name ?? null,
            note: p.note ?? null,
            effectiveDate: p.effectiveDate ?? null,
            taskId: p.taskId ?? null,
          },
        },
      })
    case "VersionApproved":
    case "VersionApprovalRejected":
    case "VersionApprovalWithdrawn": {
      if (!acc.release.pending) {
        return Result.fail(
          new EventCorruption({ reason: `${p._tag} without a pending request`, eventId: event.id }),
        )
      }
      const at = event.occurredAt.toISOString()
      const release: VersionRelease =
        p._tag === "VersionApproved"
          ? // Keep `pending` — the `VersionPublished` that follows reads the
            // requester + text off it, then clears it.
            { ...acc.release, approvedBy: event.actor, approvedAt: at }
          : p._tag === "VersionApprovalRejected"
            ? {
                ...acc.release,
                pending: null,
                lastRejection: { by: event.actor, at, reason: p.reason ?? null },
              }
            : { ...acc.release, pending: null }
      return Result.succeed({ ...acc, version: acc.version + 1, release })
    }
    case "VersionInfoSet":
      return Result.succeed({
        ...acc,
        version: acc.version + 1,
        release: {
          ...withInfo(acc.release, infoOf(p)),
          ...(p.attributedAuthor !== undefined ? { attributedAuthor: p.attributedAuthor } : {}),
          ...(p.attributedApprover !== undefined
            ? { attributedApprover: p.attributedApprover }
            : {}),
        },
      })
    // `RecordVersionDeleted` is the legacy archive tag (kept for replay); new archives
    // emit `RecordVersionArchived`. Both mark the record version archived identically.
    case "RecordVersionDeleted":
    case "RecordVersionArchived":
      return Result.succeed({ ...acc, version: acc.version + 1, archivedAt: event.occurredAt })
    case "AttachmentAdded":
      // Attachments are recorded against the record version but do not change its
      // projected state or version.
      return Result.succeed(acc)
    case "ComputedBandChanged": {
      // Materialise a coarse band marker for change-detection / automations.
      // Does NOT bump version (the display decay/momentum stay computed-on-read).
      const bands = (acc.state.__bands as Record<string, string> | undefined) ?? {}
      return Result.succeed({
        ...acc,
        state: { ...acc.state, __bands: { ...bands, [p.field]: p.to } },
      })
    }
    default:
      // Non-record version payloads should never appear in a record version stream.
      return Result.fail(
        new EventCorruption({
          reason: `unexpected payload ${p._tag} in recordVersion stream`,
          eventId: event.id,
        }),
      )
  }
}
