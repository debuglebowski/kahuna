import { Monitor, Moon, Sun } from "lucide-react"
import { setTheme, type Theme, useTheme } from "../lib/theme"
import { IconButton } from "./ui"

const ORDER: Theme[] = ["light", "dark", "system"]
const ICONS = { light: Sun, dark: Moon, system: Monitor } as const
const LABELS = { light: "Light", dark: "Dark", system: "System" } as const

/** Sidebar theme toggle — one icon button cycling light → dark → system. */
export function ThemeButton() {
  const theme = useTheme()
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? "system"
  const Icon = ICONS[theme]
  return (
    <IconButton
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${LABELS[theme]}`}
      title={`Theme: ${LABELS[theme]} — click for ${LABELS[next].toLowerCase()}`}
    >
      <Icon size={18} />
    </IconButton>
  )
}
