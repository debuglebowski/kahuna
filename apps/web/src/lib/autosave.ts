/**
 * Debounced single-value autosave against optimistic concurrency, framework-
 * free so the policy is unit-testable (`autosave.test.ts`): the latest local
 * value wins, saves are serialized through a promise chain (never two in
 * flight), the chained version only moves forward (`bumpVersion` absorbs
 * writes landing from elsewhere), and a version conflict refreshes the version
 * and retries exactly once — callers send single-field patches, so a
 * same-field collision is plain last-writer-wins.
 */

export type AutosaveStatus = "idle" | "dirty" | "saving" | "error"

export interface AutosaveOpts<T> {
  /** Persist `value` at `expectedVersion`; resolves to the server's new version. */
  readonly save: (value: T, expectedVersion: number) => Promise<number>
  /** Latest server version — fetched after a conflict, before the one retry. */
  readonly fetchVersion: () => Promise<number>
  readonly isConflict: (e: unknown) => boolean
  readonly onStatus: (status: AutosaveStatus, error: string | null) => void
  readonly debounceMs?: number
}

export interface Autosave<T> {
  /** Record a new local value; (re)starts the debounce timer. */
  readonly change: (value: T) => void
  /** Save now (blur/unmount); resolves when the save queue drains. */
  readonly flush: () => Promise<void>
  /** Raise the chained version — monotonic, lower values are ignored. */
  readonly bumpVersion: (version: number) => void
}

export function createAutosave<T>(opts: AutosaveOpts<T>): Autosave<T> {
  const debounceMs = opts.debounceMs ?? 1500
  let version = 0
  let pending: T | null = null
  let status: AutosaveStatus = "idle"
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()

  const setStatus = (s: AutosaveStatus, error: string | null = null) => {
    status = s
    opts.onStatus(s, error)
  }

  const bumpVersion = (v: number) => {
    version = Math.max(version, v)
  }

  const doSave = async (): Promise<void> => {
    const value = pending
    if (value === null) return
    pending = null
    setStatus("saving")
    try {
      let next: number
      try {
        next = await opts.save(value, version)
      } catch (e) {
        if (!opts.isConflict(e)) throw e
        bumpVersion(await opts.fetchVersion())
        next = await opts.save(value, version)
      }
      bumpVersion(next)
      // Newer keystrokes may have landed while saving — stay dirty for them.
      setStatus(pending === null ? "idle" : "dirty")
    } catch (e) {
      setStatus("error", (e as { message?: string })?.message ?? "Save failed")
    }
  }

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    chain = chain.then(doSave)
    return chain
  }

  const change = (value: T) => {
    pending = value
    if (status !== "saving") setStatus("dirty")
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => void flush(), debounceMs)
  }

  return { change, flush, bumpVersion }
}
