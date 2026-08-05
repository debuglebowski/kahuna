import type { LucideIcon } from "lucide-react"
import type { FC } from "react"
import type { Concept, Field, Label, RecordVersion, RelatedRecord } from "../../lib/api"
import type { ConceptCaps } from "../../lib/recordViews"
import type { OrgMember } from "../record/AssigneePicker"

/** Everything a tile content may need, assembled once by the record version page.
 *  Contents read what they use; mutations refresh via `refetch`. */
export interface RecordVersionCtx {
  readonly recordVersion: RecordVersion
  readonly concept: Concept
  readonly fields: ReadonlyArray<Field>
  readonly related: ReadonlyArray<RelatedRecord>
  readonly staticLabels: ReadonlyArray<Label>
  readonly ownLabels: ReadonlyArray<Label>
  readonly relationFields: ReadonlyArray<Field>
  /** Relation fields on OTHER concepts targeting this one (the inverse side). */
  readonly inboundRelationFields: ReadonlyArray<Field>
  readonly editable: boolean
  readonly admin: boolean
  readonly myUserId: string | undefined
  readonly members: ReadonlyArray<OrgMember>
  readonly concepts: ReadonlyArray<Concept>
  readonly refetch: () => void
}

/** The tile-content contract: what every catalog entry provides so a content
 *  renders the same as a lone tile or as one tab among several. */
export interface TileContent {
  readonly title: string
  readonly Icon: LucideIcon
  /** Pruned when unmet (e.g. versions on a non-versioned concept). Keyed on
   *  concept capabilities so it can be evaluated without a live record version (the
   *  concept-settings layout editor has no record version to bind). */
  readonly available?: (caps: ConceptCaps) => boolean
  /** Small count next to the title / tab label. */
  readonly Count?: FC<{ ctx: RecordVersionCtx }>
  /** Header-row actions (shown for the active tab on tabbed tiles). */
  readonly Actions?: FC<{ ctx: RecordVersionCtx }>
  readonly Body: FC<{ ctx: RecordVersionCtx }>
}
