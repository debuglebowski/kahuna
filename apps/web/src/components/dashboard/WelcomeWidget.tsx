import { useState } from "react"
import { useSession } from "@/lib/auth-client"
import { renderWelcome, WELCOME_MESSAGES } from "@/lib/welcomeMessages"

/**
 * A big-title greeting tile. The message is drawn once per mount (re-renders
 * must not reshuffle it), but the `{name}` token fills per render so a
 * slow-resolving session still ends up greeting the viewer by name.
 */
export function WelcomeWidget() {
  const { data: session } = useSession()
  const [msg] = useState(
    () => WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)]!,
  )
  return (
    <div className="flex h-full items-center overflow-hidden">
      <h1 className="text-3xl leading-tight font-bold tracking-tight text-balance text-foreground">
        {renderWelcome(msg, session?.user.name)}
      </h1>
    </div>
  )
}
