import { Smile } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { ConceptIcon, EMOJIS, ICON_NAMES, ICON_PREFIX, ICONS } from "../lib/icons"
import { cn } from "../lib/utils"

/** Split a lucide PascalCase name into lowercased words for the search filter. */
const iconKeywords = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()

/**
 * A popup that picks a single display glyph — either an emoji or a curated
 * lucide icon — and reports it as the stored string (`"🏢"` or `"lucide:Name"`).
 * Used left of the name in the concept and property editors. The trigger shows
 * the current glyph (or a neutral placeholder). `null` clears it.
 *
 * Popover behaviour mirrors {@link OrgSwitcher}: a `relative` wrapper, a
 * full-screen outside-click button, and Escape-to-close.
 */
export function IconPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<"emoji" | "icon">(
    value?.startsWith(ICON_PREFIX) ? "icon" : "emoji",
  )
  const [q, setQ] = useState("")

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  const query = q.trim().toLowerCase()
  const emojis = useMemo(
    () => (query ? EMOJIS.filter((e) => e.kw.includes(query)) : EMOJIS),
    [query],
  )
  const icons = useMemo(
    () => (query ? ICON_NAMES.filter((n) => iconKeywords(n).includes(query)) : ICON_NAMES),
    [query],
  )

  const pick = (v: string | null) => {
    onChange(v)
    setOpen(false)
    setQ("")
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Choose icon"
        title="Choose icon"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-[34px] w-[34px] items-center justify-center rounded-md border border-gray-300 bg-white transition hover:bg-gray-50 disabled:opacity-50",
          value ? "text-gray-900" : "text-gray-400",
        )}
      >
        {value ? <ConceptIcon value={value} size={20} /> : <Smile size={18} />}
      </button>

      {open && (
        <>
          {/* Outside-click closes; a real button keeps it keyboard-accessible. */}
          <button
            type="button"
            aria-label="Close icon picker"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="dialog"
            aria-label="Icon picker"
            className="absolute left-0 top-full z-20 mt-1 w-72 rounded-md border border-gray-200 bg-white p-2 shadow-lg"
          >
            <div className="mb-2 flex items-center gap-1">
              <Tab active={tab === "emoji"} onClick={() => setTab("emoji")}>
                Emoji
              </Tab>
              <Tab active={tab === "icon"} onClick={() => setTab("icon")}>
                Icon
              </Tab>
              <button
                type="button"
                onClick={() => pick(null)}
                disabled={!value}
                className="ml-auto rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-40"
              >
                None
              </button>
            </div>

            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={tab === "emoji" ? "Search emoji…" : "Search icons…"}
              className="mb-2 w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm outline-none focus:border-gray-500"
            />

            <div className="max-h-56 overflow-y-auto">
              {tab === "emoji" ? (
                <div className="grid grid-cols-8 gap-0.5">
                  {emojis.map((e) => (
                    <button
                      key={e.char}
                      type="button"
                      title={e.kw.split(" ")[0]}
                      aria-label={e.kw.split(" ")[0]}
                      onClick={() => pick(e.char)}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded text-xl leading-none hover:bg-gray-100",
                        value === e.char && "bg-gray-900/5 ring-1 ring-gray-300",
                      )}
                    >
                      {e.char}
                    </button>
                  ))}
                  {emojis.length === 0 && <Empty />}
                </div>
              ) : (
                <div className="grid grid-cols-7 gap-0.5">
                  {icons.map((name) => {
                    const Cmp = ICONS[name]
                    if (!Cmp) return null
                    const stored = `${ICON_PREFIX}${name}`
                    return (
                      <button
                        key={name}
                        type="button"
                        title={iconKeywords(name)}
                        aria-label={iconKeywords(name)}
                        onClick={() => pick(stored)}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded text-gray-700 hover:bg-gray-100",
                          value === stored && "bg-gray-900/5 text-gray-900 ring-1 ring-gray-300",
                        )}
                      >
                        <Cmp size={18} />
                      </button>
                    )
                  })}
                  {icons.length === 0 && <Empty />}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-2.5 py-1 text-xs font-medium transition",
        active ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100",
      )}
    >
      {children}
    </button>
  )
}

function Empty() {
  return <p className="col-span-full px-1 py-6 text-center text-xs text-gray-400">No matches.</p>
}
