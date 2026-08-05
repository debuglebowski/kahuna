/**
 * The `@` trigger: a TipTap Suggestion plugin bound to the `mention` node.
 *
 * Kept separate from `MentionExtension` on purpose. That file is the READER — it
 * teaches a build to display a mention, and had to ship one deploy ahead of
 * anything that can write one (an unknown node type degrades a whole document to
 * plain text). This file is the WRITER, and adding it is what turns authoring on.
 *
 * The suggestion plugin wants an imperative popup lifecycle (`onStart` / `onUpdate`
 * / `onKeyDown` / `onExit`) while the app is React, so the bridge is a small store:
 * the plugin pushes state into it, a React component subscribes and renders the
 * menu, and keystrokes route back through a ref the menu fills in.
 */

import type { Editor, Range } from "@tiptap/react"
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion"
import { useSyncExternalStore } from "react"
import { MENTION_NAME } from "./MentionExtension"
import type { MentionCandidate, MentionMenuHandle } from "./MentionSuggestion"
import { MentionMenu } from "./MentionSuggestion"

interface TriggerState {
  readonly open: boolean
  readonly query: string
  /** Viewport coords of the `@`, for positioning. */
  readonly rect: { top: number; left: number; bottom: number } | null
  readonly apply: ((c: MentionCandidate) => void) | null
}

const EMPTY: TriggerState = { open: false, query: "", rect: null, apply: null }

/** One store per editor record version — several editors can be mounted at once. */
export function createMentionTriggerStore() {
  let state: TriggerState = EMPTY
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const l of listeners) l()
  }
  return {
    get: () => state,
    set: (next: TriggerState) => {
      state = next
      emit()
    },
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    /** Keystrokes arrive from ProseMirror; the menu fills this in while open. */
    handle: { current: null as MentionMenuHandle | null },
  }
}

export type MentionTriggerStore = ReturnType<typeof createMentionTriggerStore>

/** The Suggestion config for the `@` character, bound to one store. */
export const mentionSuggestion = (
  store: MentionTriggerStore,
): Omit<SuggestionOptions, "editor"> => ({
  char: "@",
  // Only after whitespace/line start, so an email address never opens the menu.
  allowedPrefixes: [" ", "\n"],
  pluginKey: undefined as never,
  // Candidates are fetched by React (they need hooks and the query cache), so the
  // plugin itself carries none — it only reports the query.
  items: () => [],
  command: () => {},
  render: () => {
    let range: Range | null = null
    let editor: Editor | null = null

    const apply = (c: MentionCandidate) => {
      if (!editor || !range) return
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: MENTION_NAME,
            attrs: { kind: c.kind, targetId: c.targetId, label: c.label },
          },
          // A trailing space, so typing continues outside the atom.
          { type: "text", text: " " },
        ])
        .run()
      store.set(EMPTY)
    }

    const sync = (props: {
      query: string
      range: Range
      editor: Editor
      clientRect?: (() => DOMRect | null) | null
    }) => {
      range = props.range
      editor = props.editor
      const r = props.clientRect?.()
      store.set({
        open: true,
        query: props.query,
        rect: r ? { top: r.top, left: r.left, bottom: r.bottom } : null,
        apply,
      })
    }

    return {
      onStart: sync,
      onUpdate: sync,
      onKeyDown: ({ event }) => {
        if (event.key === "Escape") {
          store.set(EMPTY)
          return true
        }
        return store.handle.current?.onKeyDown(event) ?? false
      },
      onExit: () => store.set(EMPTY),
    }
  },
})

/** Renders the menu for one editor's trigger store, positioned at the caret. */
export function MentionTriggerMenu({ store }: { store: MentionTriggerStore }) {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get)
  if (!state.open || !state.rect || !state.apply) return null
  return (
    <div className="fixed z-50" style={{ top: state.rect.bottom + 4, left: state.rect.left }}>
      <MentionMenu query={state.query} onPick={state.apply} handleRef={store.handle} />
    </div>
  )
}

export { Suggestion }
