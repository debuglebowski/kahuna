import type { LucideIcon } from "lucide-react"
import type { FC } from "react"
import type { Concept, Field, Instance, Label, RelatedInstance } from "../../lib/api"
import type { OrgMember } from "../item/AssigneePicker"

/** Everything a tile content may need, assembled once by the instance page.
 *  Contents read what they use; mutations refresh via `refetch`. */
export interface InstanceCtx {
  readonly instance: Instance
  readonly concept: Concept
  readonly fields: ReadonlyArray<Field>
  readonly related: ReadonlyArray<RelatedInstance>
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
  /** Pruned when unmet (e.g. versions on a non-versioned concept). */
  readonly available?: (ctx: InstanceCtx) => boolean
  /** Small count next to the title / tab label. */
  readonly Count?: FC<{ ctx: InstanceCtx }>
  /** Header-row actions (shown for the active tab on tabbed tiles). */
  readonly Actions?: FC<{ ctx: InstanceCtx }>
  readonly Body: FC<{ ctx: InstanceCtx }>
}
