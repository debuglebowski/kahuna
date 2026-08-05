import { Monitor, Moon, Sun } from "lucide-react"
import { Card, CardHeader, ToggleChip } from "../../components/ui"
import { setTheme, type Theme, useTheme } from "../../lib/theme"

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
]

/** Local to this browser — not synced with the account. */
export function Appearance() {
  const theme = useTheme()
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Theme" />
        <div className="max-w-md space-y-2 p-6">
          <div className="flex gap-1.5">
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              <ToggleChip
                key={value}
                pressed={theme === value}
                onPressedChange={() => setTheme(value)}
              >
                <Icon size={14} />
                {label}
              </ToggleChip>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Saved in this browser only — not synced with your account.
          </p>
        </div>
      </Card>
    </div>
  )
}
