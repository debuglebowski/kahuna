/**
 * `@` mentions: the inline references a rich-text document can carry.
 *
 * The DOCUMENT is the source of truth. A mention lives as a `mention` node inside
 * the ProseMirror doc (`record_versions.state[fieldId].doc`, `annotations.description.doc`),
 * carrying `{ kind, targetId, label }` and nothing else. The `mentions` TABLE is a
 * derived index, rebuilt from the doc on every write of it — it exists only so
 * "what mentions this record?" is an indexed query instead of a scan of every
 * document in the org. Nothing should ever read a mention's identity from the table
 * that could read it from the doc.
 *
 * Extraction is server-side for the same reason `text` is derived server-side: the
 * client's copy of anything in this envelope is never trusted.
 */

/** Mirrored by the web client's `lib/mentionKinds.tsx` (the client tree does not
 *  import `#engine`; see `richtext.ts` for the same arrangement). */
export const MENTION_KINDS = ["record", "person", "page", "concept", "dashboard", "file"] as const
export type MentionKind = (typeof MENTION_KINDS)[number]

const KIND_SET: ReadonlySet<string> = new Set(MENTION_KINDS)

export interface MentionRef {
  readonly kind: MentionKind
  readonly targetId: string
}

/**
 * Index rows written per source document. The DOCUMENT is unaffected by this cap —
 * every mention in it still renders and still links; only the backlink index
 * truncates. That asymmetry is deliberate: the rendering is the user's content,
 * the index is a convenience, and an unbounded doc could otherwise insert a
 * six-figure number of rows inside the save transaction.
 */
export const MAX_MENTIONS_PER_DOC = 500

/** Stable de-dupe key. `\u0000` cannot occur in a uuid or a nav key, so it can't
 *  be forged by a targetId that happens to contain the separator. */
const refKey = (kind: string, targetId: string) => `${kind}\u0000${targetId}`

/**
 * Every distinct mention in a ProseMirror doc, in document order, capped.
 *
 * Malformed nodes are DROPPED rather than rejected: an unknown `kind` (written by
 * a newer build) or a missing `targetId` still renders in the document, it simply
 * earns no index row. A write must never fail because of what this function finds
 * — the user's document is not hostage to the backlink index.
 */
export const extractMentions = (doc: unknown): ReadonlyArray<MentionRef> => {
  const out: MentionRef[] = []
  const seen = new Set<string>()

  const walk = (node: unknown): void => {
    if (out.length >= MAX_MENTIONS_PER_DOC) return
    if (typeof node !== "object" || node === null) return
    const o = node as { type?: unknown; attrs?: unknown; content?: unknown }
    if (o.type === "mention") {
      const attrs = o.attrs as { kind?: unknown; targetId?: unknown } | null
      const kind = attrs?.kind
      const targetId = attrs?.targetId
      if (
        typeof kind === "string" &&
        KIND_SET.has(kind) &&
        typeof targetId === "string" &&
        targetId !== ""
      ) {
        const key = refKey(kind, targetId)
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ kind: kind as MentionKind, targetId })
        }
      }
      return
    }
    if (Array.isArray(o.content)) for (const child of o.content) walk(child)
  }

  walk(doc)
  return out
}

/** Postgres will error rather than return no rows if a non-uuid string reaches a
 *  `uuid[]` comparison, so a `targetId` is shape-checked before it is used as one.
 *  Only `record` mentions ever are — see `mentions.target_record_id`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: string): boolean => UUID_RE.test(v)
