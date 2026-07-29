/**
 * Pure routing for live-sync envelopes — no React / TanStack deps, fully
 * unit-testable. Maps an incoming SSE envelope to the collection keys that
 * should refetch, given which collections are currently mounted.
 *
 * The envelope is metadata only (mirrors the server's `EventEnvelope`); it is
 * never rendered, only used to decide what to re-read.
 */

export interface LiveEnvelope {
  readonly org: string
  readonly id: number
  readonly at: number
  // "item" = whole-item archive/restore (carries conceptId → refetches the concept
  // list + open details, like an instance event). "note"/"task"/"taskStatus"/
  // "annotationField" = the annotation layer (subjectId is the annotation/def id,
  // NOT the host item — so we fan out to all mounted panels of that kind).
  readonly kind:
    | "instance"
    | "relation"
    | "concept"
    | "field"
    | "item"
    | "note"
    | "task"
    | "taskStatus"
    | "taskPriority"
    | "annotationField"
    | "attachment"
  readonly subjectId: string
  readonly type: string
  /** Concept id for instance events — routes to the id-keyed instance collection. */
  readonly conceptId: string | null
  /** Concept name for instance events — informational (mirrors the wire envelope). */
  readonly concept: string | null
}

export const KEY = {
  concepts: "concepts",
  changed: "changed",
  instances: (concept: string) => `instances:${concept}`,
  /** A single instance's detail view (its own data + connected instances). */
  detail: (id: string) => `detail:${id}`,
  /** A single-record concept's record, resolved concept id → instance id. Keyed by
   *  CONCEPT id, not instance id: for a versioned concept the instance id changes
   *  every time a version is published, and this is the thing that must notice. */
  singleRecord: (conceptId: string) => `singleRecord:${conceptId}`,
  /** Sidebar Views — not driven by engine events (no envelope routes here);
   *  refreshed on the caller's own mutations and by the safety-refetch sweep. */
  views: "views",
  // ── annotation layer (subjectId = the item lineage id) ───────────────────────
  /** Notes panel for an item. */
  notes: (subjectId: string) => `notes:${subjectId}`,
  /** Tasks panel for an item. */
  tasks: (subjectId: string) => `tasks:${subjectId}`,
  /** Per-item activity feed. */
  activity: (subjectId: string) => `activity:${subjectId}`,
  /** Global "My Tasks" view (cross-item). */
  tasksGlobal: "tasks:global",
  /** Files panel for an item. */
  files: (subjectId: string) => `files:${subjectId}`,
  /** Dashboard Files widgets (any scope) — one shared nudge key. */
  filesGlobal: "files:global",
  /** Org-wide task-status vocabulary. */
  taskStatuses: "taskStatuses",
  /** Org-wide task-priority vocabulary. */
  taskPriorities: "taskPriorities",
  /** Annotation custom-field defs for a type. */
  annotationFields: (type: string) => `annotationFields:${type}`,
} as const

/**
 * Returns the subset of collection keys to refetch for this envelope, filtered
 * to those actually mounted. Every event also nudges the `changed` feed.
 */
export const routeEnvelope = (env: LiveEnvelope, mounted: ReadonlyArray<string>): string[] => {
  const candidates = new Set<string>([KEY.changed])

  // An open instance-detail page may show this subject — directly, as a connected
  // instance, or via a relation just added/removed — so any instance/relation event
  // nudges every mounted detail page (the envelope can't say which one is affected).
  const details = mounted.filter((k) => k.startsWith("detail:"))

  // The annotation envelope's subjectId is the annotation/def id, not the host
  // item, so fan out to every mounted panel of the relevant kind (a user usually
  // has just one open). Always also nudge the per-item activity feeds.
  const byPrefix = (prefix: string) => mounted.filter((k) => k.startsWith(prefix))

  if (env.kind === "concept" || env.kind === "field") {
    candidates.add(KEY.concepts)
  } else if (env.kind === "relation") {
    // A relation change can affect any open detail page (connected instances).
    for (const k of details) candidates.add(k)
  } else if (env.kind === "note") {
    for (const k of byPrefix("notes:")) candidates.add(k)
    for (const k of byPrefix("activity:")) candidates.add(k)
  } else if (env.kind === "task") {
    for (const k of byPrefix("tasks:")) candidates.add(k)
    for (const k of byPrefix("activity:")) candidates.add(k)
  } else if (env.kind === "attachment") {
    // Covers the per-item panels AND the widgets' shared "files:global" key.
    for (const k of byPrefix("files:")) candidates.add(k)
    for (const k of byPrefix("activity:")) candidates.add(k)
  } else if (env.kind === "taskStatus") {
    candidates.add(KEY.taskStatuses)
    for (const k of byPrefix("tasks:")) candidates.add(k)
  } else if (env.kind === "taskPriority") {
    candidates.add(KEY.taskPriorities)
    for (const k of byPrefix("tasks:")) candidates.add(k)
  } else if (env.kind === "annotationField") {
    for (const k of byPrefix("annotationFields:")) candidates.add(k)
    for (const k of byPrefix("notes:")) candidates.add(k)
    for (const k of byPrefix("tasks:")) candidates.add(k)
  } else {
    // instance / item — nudge its concept's list and any open detail pages.
    if (env.conceptId) candidates.add(KEY.instances(env.conceptId))
    for (const k of details) candidates.add(k)
    // A single-record concept resolves concept id → its one record; publishing a
    // new version changes which instance id that is, so the resolution itself has
    // to re-run, not just the detail it points at.
    if (env.conceptId) candidates.add(KEY.singleRecord(env.conceptId))
    // An instance edit also surfaces in its item's activity feed.
    for (const k of byPrefix("activity:")) candidates.add(k)
  }

  const mountedSet = new Set(mounted)
  return [...candidates].filter((k) => mountedSet.has(k))
}
