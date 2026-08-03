import { ssoClient } from "@better-auth/sso/client"
import { organizationClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient({
  // `ssoClient` adds `signIn.sso` (used by AuthPage). Provider REGISTRATION is
  // deliberately not driven from here — it goes through `/api/auth-config/sso`,
  // which narrows the permission from better-auth's owner-or-admin to owner.
  plugins: [organizationClient(), ssoClient()],
})

export const { useSession, signOut } = authClient
