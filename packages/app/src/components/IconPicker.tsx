import { Smile } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ConceptIcon, EMOJIS, ICON_NAMES, ICON_PREFIX, ICONS } from "../lib/icons"
import { cn } from "../lib/utils"

/** Split a lucide PascalCase name into lowercased words for the search filter. */
const iconKeywords = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()

/**
 * A popover that picks a single display glyph — either an emoji or a curated
 * lucide icon — and reports it as the stored string (`"🏢"` or `"lucide:Name"`).
 * Used left of the name in the concept and property editors. The trigger shows
 * the current glyph (or a neutral placeholder). `null` clears it. Built on the
 * shadcn {@link Popover}, which owns outside-click / Escape / focus handling.
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
  const inputRef = useRef<HTMLInputElement>(null)

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label="Choose icon"
        title="Choose icon"
        className={cn(
          "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md border border-input bg-background transition hover:bg-accent disabled:opacity-50",
          value ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {value ? <ConceptIcon value={value} size={20} /> : <Smile size={18} />}
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-72 p-2"
        onOpenAutoFocus={(e) => {
          // Land focus on the search box instead of the first grid cell.
          e.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <Tabs value={tab} onValueChange={(v) => setTab(v as "emoji" | "icon")} className="gap-2">
          <div className="flex items-center gap-1">
            <TabsList className="h-8">
              <TabsTrigger value="emoji" className="text-xs">
                Emoji
              </TabsTrigger>
              <TabsTrigger value="icon" className="text-xs">
                Icon
              </TabsTrigger>
            </TabsList>
            <button
              type="button"
              onClick={() => pick(null)}
              disabled={!value}
              className="ml-auto rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
            >
              None
            </button>
          </div>

          <Input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tab === "emoji" ? "Search emoji…" : "Search icons…"}
          />

          <div className="max-h-56 overflow-y-auto">
            <TabsContent value="emoji" className="mt-0">
              <div className="grid grid-cols-8 gap-0.5">
                {emojis.map((e) => (
                  <button
                    key={e.char}
                    type="button"
                    title={e.kw.split(" ")[0]}
                    aria-label={e.kw.split(" ")[0]}
                    onClick={() => pick(e.char)}
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded text-xl leading-none hover:bg-accent",
                      value === e.char && "bg-accent ring-1 ring-ring",
                    )}
                  >
                    {e.char}
                  </button>
                ))}
                {emojis.length === 0 && <Empty />}
              </div>
            </TabsContent>
            <TabsContent value="icon" className="mt-0">
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
                        "flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-accent",
                        value === stored && "bg-accent ring-1 ring-ring",
                      )}
                    >
                      <Cmp size={18} />
                    </button>
                  )
                })}
                {icons.length === 0 && <Empty />}
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </PopoverContent>
    </Popover>
  )
}

function Empty() {
  return (
    <p className="col-span-full px-1 py-6 text-center text-xs text-muted-foreground">No matches.</p>
  )
}
