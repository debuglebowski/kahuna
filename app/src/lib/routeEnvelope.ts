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
  // "record" = whole-record archive/restore (carries conceptId → refetches the concept
  // list + open details, like a record version event). "note"/"task"/"taskStatus"/
  // "annotationField" = the annotation layer (subjectId is the annotation/def id,
  // NOT the host record — so we fan out to all mounted panels of that kind).
  readonly kind:
    | "recordVersion"
    | "relation"
    | "concept"
    | "field"
    | "record"
    | "note"
    | "task"
    | "taskStatus"
    | "taskPriority"
    | "annotationField"
    | "attachment"
    | "automation"
  readonly subjectId: string
  readonly type: string
  /** Concept id for record version events — routes to the id-keyed record version collection. */
  readonly conceptId: string | null
  /** Concept name for record version events — informational (mirrors the wire envelope). */
  readonly concept: string | null
  /** Who caused it (mirrors the wire envelope). Present for the automation
   *  runner's one-hop guard; the client only reads it for display. */
  readonly actor?: string | null
}

export const KEY = {
  concepts: "concepts",
  changed: "changed",
  recordVersions: (concept: string) => `recordVersions:${concept}`,
  /** A single record version's detail view (its own data + connected record versions). */
  detail: (id: string) => `detail:${id}`,
  /** A single-record concept's record, resolved concept id → record version id. Keyed by
   *  CONCEPT id, not record version id: for a versioned concept the record version id changes
   *  every time a version is published, and this is the thing that must notice. */
  singleRecord: (conceptId: string) => `singleRecord:${conceptId}`,
  /** Sidebar Views — not driven by engine events (no envelope routes here);
   *  refreshed on the caller's own mutations and by the safety-refetch sweep. */
  views: "views",
  // ── annotation layer (subjectId = the record id) ───────────────────────
  /** Notes panel for a record. */
  notes: (subjectId: string) => `notes:${subjectId}`,
  /** Tasks panel for a record. */
  tasks: (subjectId: string) => `tasks:${subjectId}`,
  /** Per-record activity feed. */
  activity: (subjectId: string) => `activity:${subjectId}`,
  /** Global "My Tasks" view (cross-record). */
  tasksGlobal: "tasks:global",
  /** Files panel for a record. */
  files: (subjectId: string) => `files:${subjectId}`,
  /** Dashboard Files widgets (any scope) — one shared nudge key. */
  filesGlobal: "files:global",
  /** Org-wide task-status vocabulary. */
  taskStatuses: "taskStatuses",
  /** Org-wide task-priority vocabulary. */
  taskPriorities: "taskPriorities",
  /** Annotation custom-field defs for a type. */
  annotationFields: (type: string) => `annotationFields:${type}`,
  /** Org-wide automation list (settings). */
  automations: "automations",
  /** One automation's run history (the editor's panel). */
  automationRuns: (id: string) => `automationRuns:${id}`,
} as const

/**
 * Returns the subset of collection keys to refetch for this envelope, filtered
 * to those actually mounted. Every event also nudges the `changed` feed.
 */
export const routeEnvelope = (env: LiveEnvelope, mounted: ReadonlyArray<string>): string[] => {
  const candidates = new Set<string>([KEY.changed])

  // An open record version-detail page may show this subject — directly, as a connected
  // record version, or via a relation just added/removed — so any record version/relation event
  // nudges every mounted detail page (the envelope can't say which one is affected).
  const details = mounted.filter((k) => k.startsWith("detail:"))

  // The annotation envelope's subjectId is the annotation/def id, not the host
  // record, so fan out to every mounted panel of the relevant kind (a user usually
  // has just one open). Always also nudge the per-record activity feeds.
  const byPrefix = (prefix: string) => mounted.filter((k) => k.startsWith(prefix))

  if (env.kind === "concept" || env.kind === "field") {
    candidates.add(KEY.concepts)
  } else if (env.kind === "relation") {
    // A relation change can affect any open detail page (connected record versions).
    for (const k of details) candidates.add(k)
  } else if (env.kind === "note") {
    for (const k of byPrefix("notes:")) candidates.add(k)
    for (const k of byPrefix("activity:")) candidates.add(k)
  } else if (env.kind === "task") {
    for (const k of byPrefix("tasks:")) candidates.add(k)
    for (const k of byPrefix("activity:")) candidates.add(k)
  } else if (env.kind === "attachment") {
    // Covers the per-record panels AND the widgets' shared "files:global" key.
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
  } else if (env.kind === "automation") {
    // Definition edits + an AutomationRan with no record both land here. The
    // settings list shows run counts, so it refetches either way.
    candidates.add(KEY.automations)
    for (const k of byPrefix("automationRuns:")) candidates.add(k)
  } else {
    // record version / record — nudge its concept's list and any open detail pages.
    if (env.conceptId) candidates.add(KEY.recordVersions(env.conceptId))
    for (const k of details) candidates.add(k)
    // A single-record concept resolves concept id → its one record; publishing a
    // new version changes which record version id that is, so the resolution itself has
    // to re-run, not just the detail it points at.
    if (env.conceptId) candidates.add(KEY.singleRecord(env.conceptId))
    // A record version edit also surfaces in its record's activity feed.
    for (const k of byPrefix("activity:")) candidates.add(k)
    // An `AutomationRan` rides the acted-on RECORD's stream (so the record's feed
    // explains itself), but it is also new run history — nudge the open editor.
    if (env.type === "AutomationRan") {
      candidates.add(KEY.automations)
      for (const k of byPrefix("automationRuns:")) candidates.add(k)
    }
  }

  const mountedSet = new Set(mounted)
  return [...candidates].filter((k) => mountedSet.has(k))
}
