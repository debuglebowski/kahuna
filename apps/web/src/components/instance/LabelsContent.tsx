import { useMutation, useQuery } from "@tanstack/react-query"
import { Check } from "lucide-react"
import { useEffect, useState } from "react"
import { LABELS_KEY } from "../../../rpc/contract"
import { api } from "../../lib/api"
import { LabelMultiSelect } from "../LabelMultiSelect"
import { Button, LabelChip } from "../ui"
import type { InstanceCtx } from "./types"

/**
 * Per-item label editor. Inherited (static) labels render as locked chips; the
 * item's own labels are a draft multi-select saved via `updateInstance`. The
 * draft reseeds whenever the server's label set changes (after our save, or an
 * external edit) — keyed by the id set. The save button lives in the body so
 * the content works the same as a tile or a tab.
 */
export function LabelsBody({ ctx }: { ctx: InstanceCtx }) {
  const { instance, staticLabels, ownLabels, editable, refetch } = ctx
  const vocab = useQuery({ queryKey: ["labels"], queryFn: () => api.listLabels() })
  const serverKey = ownLabels.map((l) => l.id).join(",")
  const serverIds = serverKey ? serverKey.split(",") : []
  const [draft, setDraft] = useState<string[]>(serverIds)
  // Reseed to the server truth whenever it changes (not while editing a draft).
  useEffect(() => {
    setDraft(serverKey ? serverKey.split(",") : [])
  }, [serverKey])

  const save = useMutation({
    mutationFn: () => api.updateInstance(instance.id, instance.version, { [LABELS_KEY]: draft }),
    onSuccess: refetch,
  })

  const hasVocab = (vocab.data?.length ?? 0) > 0
  const dirty = draft.length !== serverIds.length || draft.some((id) => !serverIds.includes(id))
  const staticIds = staticLabels.map((l) => l.id)

  return (
    <div className="space-y-3 p-6">
      {staticLabels.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Inherited</span>
          <div className="flex flex-wrap gap-1.5">
            {staticLabels.map((l) => (
              <LabelChip
                key={l.id}
                color={l.color}
                primary={l.primary}
                title="Inherited from the concept"
              >
                {l.name}
              </LabelChip>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">This item</span>
        {/* A frozen (published) version can't take label writes — read-only chips. */}
        {hasVocab && editable ? (
          <LabelMultiSelect
            all={vocab.data ?? []}
            selectedIds={draft}
            onChange={setDraft}
            excludeIds={staticIds}
            emptyHint="No labels available."
          />
        ) : ownLabels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {ownLabels.map((l) => (
              <LabelChip key={l.id} color={l.color} primary={l.primary}>
                {l.name}
              </LabelChip>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">None.</p>
        )}
      </div>
      {dirty && (
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            <Check size={15} />
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
      {save.error && <p className="text-sm text-destructive">{(save.error as Error).message}</p>}
    </div>
  )
}
