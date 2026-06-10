import { useLiveQuery } from "@tanstack/react-db"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Archive, EllipsisVertical, Pencil, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { InstanceViewCanvas } from "../components/instance/InstanceViewCanvas"
import { InstanceViewEditor } from "../components/instance/InstanceViewEditor"
import { capsOf } from "../components/instance/registry"
import type { InstanceCtx } from "../components/instance/types"
import { ViewSwitcher } from "../components/instance/ViewSwitcher"
import { Badge, Button, ConfirmDialog, Spinner } from "../components/ui"
import { api, type Field } from "../lib/api"
import { useSession } from "../lib/auth-client"
import { instanceDetail, KEY, useRegisterCollection } from "../lib/collections"
import {
  CUSTOM_VIEW_KEY,
  resolveView,
  useInstanceViewPrefs,
  type ViewTile,
} from "../lib/instanceViews"
import { isRichTextEmpty, richTextPreview } from "../lib/richtext"
import { isAdminRole, useFullOrg } from "./settings/SettingsLayout"

/** A human label for an instance — its first non-empty text field, else its
 *  first non-empty rich text field, else untitled. State is keyed by field id,
 *  so the concept's field defs are required. */
const labelOf = (state: Record<string, unknown>, fields: ReadonlyArray<Field>): string => {
  const textField = fields.find((f) => f.kind === "text" && state[f.id])
  const v = textField ? state[textField.id] : undefined
  if (v) return String(v)
  const rich = fields.find((f) => f.kind === "richtext" && !isRichTextEmpty(state[f.id]))
  return rich ? richTextPreview(state[rich.id], 80) : "(untitled)"
}

/** Single-instance detail: all of its own data plus everything connected to it,
 *  rendered through the user's chosen view (preset tile layouts). */
export function InstanceView() {
  const { id = "" } = useParams()

  const collection = instanceDetail(id)
  useRegisterCollection(KEY.detail(id), collection)
  const detailQ = useLiveQuery(
    (q) => (id ? q.from({ d: collection }) : undefined),
    [id, collection],
  )
  const detail = detailQ.data?.[0]

  // A hard delete is admin-only; archive is an ordinary item write.
  const navigate = useNavigate()
  const { data: session } = useSession()
  const org = useFullOrg()
  const myRole = org.data?.members?.find((m) => m.userId === session?.user.id)?.role
  const admin = isAdminRole(myRole)
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null)
  const [editingLayout, setEditingLayout] = useState(false)
  // Navigating to another instance exits edit mode — the editor seeds from the
  // view it was opened on and must not carry tiles across concepts.
  useEffect(() => setEditingLayout(false), [id])

  // All concepts — to resolve relation targets' versioningEnabled in the picker.
  const allConcepts = useQuery({ queryKey: ["concepts"], queryFn: () => api.listConcepts() })
  const prefs = useInstanceViewPrefs()

  // Both navigate back to the concept on success (the item leaves the live view).
  const backToConcept = () => {
    if (detail) navigate(`/concepts/${detail.concept.id}`)
  }
  const archive = useMutation({
    mutationFn: (inst: { id: string; version: number }) =>
      api.archiveInstance(inst.id, inst.version),
    onSuccess: () => {
      setDialog(null)
      backToConcept()
    },
  })
  // For a versioned concept the header "Archive" hides the whole item (lineage);
  // per-version archive lives in the Versions panel.
  const archiveItem = useMutation({
    mutationFn: (itemId: string) => api.archiveItem(itemId),
    onSuccess: () => {
      setDialog(null)
      backToConcept()
    },
  })
  const del = useMutation({
    mutationFn: (instId: string) => api.deleteInstance(instId),
    onSuccess: () => {
      setDialog(null)
      backToConcept()
    },
  })
  // Wait for prefs too — rendering the default view and snapping to the chosen
  // one a beat later reads as a layout glitch.
  if (detailQ.isLoading || !detail || !prefs.loaded) return <Spinner />

  const { instance, concept, fields, related, staticLabels, labels } = detail
  // Fields and relations are editable on a draft (versioned) or any
  // non-versioned instance — a published version is frozen, connections included.
  const relationFields = fields.filter((f) => f.kind === "relation")
  const editable = concept.versioningEnabled ? instance.versionStatus === "draft" : true

  const view = resolveView(prefs.body, concept.id)
  // Saving the editor's result makes it this concept's custom layout and
  // switches the concept override to it in the same write.
  const saveCustomLayout = (tiles: ViewTile[]) =>
    prefs.update.mutate(
      {
        ...prefs.body,
        byConcept: { ...prefs.body.byConcept, [concept.id]: CUSTOM_VIEW_KEY },
        customByConcept: { ...prefs.body.customByConcept, [concept.id]: { tiles } },
      },
      { onSuccess: () => setEditingLayout(false) },
    )
  const ctx: InstanceCtx = {
    instance,
    concept,
    fields,
    related,
    staticLabels,
    ownLabels: labels,
    relationFields,
    editable,
    admin,
    myUserId: session?.user.id,
    members: org.data?.members ?? [],
    concepts: allConcepts.data ?? [],
    refetch: () => collection.utils.refetch(),
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-1.5 text-base font-medium text-foreground">
          <Link
            to={`/concepts/${concept.id}`}
            className="truncate text-muted-foreground transition-colors hover:text-foreground"
          >
            {concept.pluralName || concept.name}
          </Link>
          <span className="text-muted-foreground/50">/</span>
          <span className="truncate">{labelOf(instance.state, fields)}</span>
          {concept.versioningEnabled &&
            (instance.versionStatus === "draft" ? (
              <Badge tone="amber">Draft v{instance.versionSeq}</Badge>
            ) : (
              <Badge tone="gray">v{instance.versionSeq}</Badge>
            ))}
        </h2>
        <div className="flex items-center gap-2">
          {!editingLayout && (
            <ViewSwitcher conceptId={concept.id} onEditLayout={() => setEditingLayout(true)} />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="shrink-0" aria-label="Item actions">
                <EllipsisVertical size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => navigate(`/settings/concepts?concept=${concept.id}`)}
              >
                <Pencil size={15} />
                Edit concept
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("archive")}>
                <Archive size={15} />
                Archive
              </DropdownMenuItem>
              {admin && (
                <DropdownMenuItem variant="destructive" onSelect={() => setDialog("delete")}>
                  <Trash2 size={15} />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {editingLayout ? (
        <InstanceViewEditor
          initial={view.tiles(capsOf(ctx))}
          ctx={ctx}
          onSave={saveCustomLayout}
          onCancel={() => setEditingLayout(false)}
          saving={prefs.update.isPending}
        />
      ) : (
        <InstanceViewCanvas view={view} ctx={ctx} />
      )}

      {dialog === "archive" && (
        <ConfirmDialog
          title="Archive item"
          message={
            concept.versioningEnabled ? (
              <>
                Archive <strong>{labelOf(instance.state, fields)}</strong> and all its versions?
                It's hidden from lists but kept — restore it from "Show archived".
              </>
            ) : (
              <>
                Archive <strong>{labelOf(instance.state, fields)}</strong>? It's hidden from lists
                but kept — you can restore it from the {concept.name} view's "Show archived".
              </>
            )
          }
          confirmLabel="Archive"
          pending={archive.isPending || archiveItem.isPending}
          error={
            (archive.error || archiveItem.error
              ? ((archive.error || archiveItem.error) as { message?: string }).message
              : undefined) ?? undefined
          }
          onConfirm={() =>
            concept.versioningEnabled
              ? archiveItem.mutate(instance.itemId)
              : archive.mutate(instance)
          }
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title="Delete item"
          message={
            <>
              Permanently delete <strong>{labelOf(instance.state, fields)}</strong>? This can't be
              undone, and is refused while other items still link to it.
            </>
          }
          confirmLabel="Delete"
          confirmVariant="danger"
          secondaryLabel="Archive instead"
          onSecondary={() => archive.mutate(instance)}
          pending={del.isPending || archive.isPending}
          error={
            del.error
              ? ((del.error as { message?: string }).message ?? "Could not delete.")
              : undefined
          }
          onConfirm={() => del.mutate(instance.id)}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  )
}
