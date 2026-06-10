import { useLiveQuery } from "@tanstack/react-db"
import { useQueries, useQuery } from "@tanstack/react-query"
import { LayoutDashboard, Mail, Plus } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Layout } from "react-grid-layout"
import { useParams } from "react-router-dom"
import { WidgetCanvas } from "@/components/dashboard/WidgetCanvas"
import { WidgetEditor } from "@/components/dashboard/WidgetEditor"
import { Badge, Card, Spinner } from "@/components/ui"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, type Concept, type DashboardBody, type DashboardWidget, type Field } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import { conceptsCollection, KEY, useRegisterCollection } from "@/lib/collections"
import { conceptIndex, useConceptData } from "@/lib/conceptData"
import {
  addWidget,
  applyLayouts,
  newWidget,
  referencedConceptIds,
  removeWidget,
  updateWidget,
} from "@/lib/dashboards"
import { memberLabel, useMembers } from "@/lib/members"
import { initialsOf } from "@/lib/utils"

const roleTone = (role: string) => (role === "owner" ? "blue" : role === "admin" ? "amber" : "gray")

/**
 * Build the default page shown until the member customises theirs: one list
 * widget per concept that has a user-kind field, filtered to this member
 * ("assigned to you"). Computed at render time and NEVER persisted — it tracks
 * schema changes for free, and a future Tasks widget just joins the seed.
 */
const seedWidgets = (
  fieldsByConcept: ReadonlyArray<readonly [string, ReadonlyArray<Field>]>,
  cIndex: Map<string, Concept>,
  userId: string,
): DashboardBody => {
  const widgets: DashboardWidget[] = []
  for (const [conceptId, fields] of fieldsByConcept) {
    const userField = fields.find((f) => f.kind === "user")
    if (!userField) continue
    const concept = cIndex.get(conceptId)
    const n = widgets.length
    widgets.push({
      id: `seed-${conceptId}`,
      type: "list",
      title: concept ? `${concept.pluralName || concept.name} · ${userField.name}` : null,
      layout: { x: (n % 2) * 6, y: Math.floor(n / 2) * 4, w: 6, h: 4 },
      conceptId,
      conditions: [{ field: userField.id, op: "eq", value: userId }],
      orderBy: null,
      limit: 10,
    })
  }
  return { widgets }
}

/**
 * A member's profile page (`/members/:userId`): identity header + a widget
 * canvas with the same machinery as dashboards. Only the member themself may
 * edit (enforced server-side too — `updateMemberPage` always writes the
 * caller's own page); everyone else gets a read-only canvas.
 */
export function MemberProfile() {
  const { userId = "" } = useParams()
  const { data: session } = useSession()
  const { members, deactivatedSet, isPending: membersPending } = useMembers()
  const conceptsLive = useLiveQuery((q) => q.from({ c: conceptsCollection }))
  useRegisterCollection(KEY.concepts, conceptsCollection)
  const concepts = (conceptsLive.data ?? []) as Concept[]
  const conceptsLoaded = !!conceptsLive.data
  const cIndex = useMemo(() => conceptIndex(concepts), [concepts])

  const isOwner = session?.user.id === userId
  const member = members.find((m) => m.userId === userId)

  const page = useQuery({
    queryKey: ["memberPage", userId],
    queryFn: () => api.getMemberPage(userId),
    enabled: !!userId,
  })

  // Field defs of every concept — the seed needs to know which have user fields.
  // `combine` keeps the result structurally shared, so the seed memo below only
  // recomputes when a field list actually changes.
  const fieldsByConcept = useQueries({
    queries: concepts.map((c) => ({
      queryKey: ["fields", c.id],
      queryFn: () => api.listFields(c.id),
    })),
    combine: (results) =>
      concepts.map((c, i) => [c.id, (results[i]?.data ?? []) as Field[]] as const),
  })

  // Local working copy (the dashboards pattern): (re)loaded when the subject
  // changes, so live refetches never clobber in-flight edits.
  const [body, setBody] = useState<DashboardBody | null>(null)
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (page.data && loadedFor.current !== userId) {
      loadedFor.current = userId
      setBody(page.data.body)
    }
  }, [page.data, userId])

  // An un-customised page renders the computed seed; the first edit persists it.
  const seed = useMemo(
    () => seedWidgets(fieldsByConcept, cIndex, userId),
    [fieldsByConcept, cIndex, userId],
  )
  const effective = body && body.widgets.length > 0 ? body : seed

  const ids = useMemo(() => referencedConceptIds(effective), [effective])
  const { instData, loaders } = useConceptData(ids)

  const mutate = useCallback((next: DashboardBody) => {
    setBody(next)
    void api.updateMemberPage(next)
  }, [])
  const onStop = useCallback(
    (layout: Layout[]) => mutate(applyLayouts(effective, layout)),
    [effective, mutate],
  )

  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = effective.widgets.find((w) => w.id === editingId) ?? null

  const addOfType = (type: DashboardWidget["type"]) => {
    const w = newWidget(effective, type)
    mutate(addWidget(effective, w))
    setEditingId(w.id)
  }

  if (membersPending || (page.isPending && !!userId)) return <Spinner />
  if (!member) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">
          No such member — they may have been removed from the org.
        </p>
      </Card>
    )
  }

  const label = memberLabel(member, userId)
  const email = member.user?.email
  const deactivated = deactivatedSet.has(userId)

  return (
    <div className="flex flex-col gap-4">
      {loaders}
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-12">
            <AvatarImage src={member.user?.image ?? undefined} alt="" />
            <AvatarFallback>{initialsOf(member.user?.name, email ?? userId)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-xl font-semibold text-foreground">{label}</h2>
              {deactivated && <Badge tone="red">deactivated</Badge>}
              <Badge tone={roleTone(member.role)}>{member.role}</Badge>
            </div>
            {email && (
              <a
                href={`mailto:${email}`}
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
              >
                <Mail size={13} />
                {email}
              </a>
            )}
          </div>
        </div>

        {isOwner && (
          <Select value="" onValueChange={(t) => addOfType(t as DashboardWidget["type"])}>
            <SelectTrigger className="cancel-drag" size="sm">
              <Plus size={14} />
              <SelectValue placeholder="Add widget" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="metric">Metric</SelectItem>
              <SelectItem value="list">List / Table</SelectItem>
              <SelectItem value="breakdown">Breakdown</SelectItem>
              <SelectItem value="attention">Attention</SelectItem>
              <SelectItem value="trend">Trend</SelectItem>
              <SelectItem value="activity">Activity</SelectItem>
            </SelectContent>
          </Select>
        )}
      </header>

      {effective.widgets.length === 0 ? (
        <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed p-12 text-center">
          <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <LayoutDashboard size={20} />
          </div>
          <h2 className="mb-1 text-lg font-medium text-foreground">Nothing here yet</h2>
          <p className="max-w-sm text-sm text-balance text-muted-foreground">
            {isOwner
              ? "Add a widget to show colleagues what you're working on."
              : `${label} hasn't put anything on their page yet.`}
          </p>
        </div>
      ) : (
        <WidgetCanvas
          body={effective}
          instData={instData}
          cIndex={cIndex}
          conceptsLoaded={conceptsLoaded}
          readOnly={!isOwner}
          onStop={onStop}
          onEdit={setEditingId}
          onRemove={(id) => mutate(removeWidget(effective, id))}
        />
      )}

      {isOwner && editing && (
        <WidgetEditor
          widget={editing}
          concepts={concepts}
          onSave={(w) => mutate(updateWidget(effective, w.id, w))}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  )
}
