import { useQuery } from "@tanstack/react-query"
import { useFullOrg } from "../pages/settings/SettingsLayout"
import { api } from "./api"

/**
 * Shared member-directory data: the BetterAuth member list (via `useFullOrg`)
 * joined with the org's deactivation markers. Deactivated members keep their
 * membership (BetterAuth doesn't know about deactivation) — surfaces decide
 * what to do with the flag: pickers drop them, lists badge them, the server
 * blocks their org access.
 */

/** One directory entry: the BetterAuth member shape used across the app. */
export interface OrgMember {
  readonly id: string
  readonly userId: string
  readonly role: string
  readonly user?: {
    readonly id?: string
    readonly name?: string | null
    readonly email?: string | null
    readonly image?: string | null
  } | null
}

export const memberLabel = (m: OrgMember | undefined, fallback: string): string =>
  m?.user?.name?.trim() || m?.user?.email || fallback

/** The org's deactivation markers as a userId set (member-readable). */
export function useDeactivated() {
  const q = useQuery({
    queryKey: ["deactivatedMembers"],
    queryFn: () => api.listDeactivatedMembers(),
  })
  return { ...q, set: new Set((q.data ?? []).map((d) => d.userId)) }
}

/** The member list with each entry's deactivation flag resolved. */
export function useMembers() {
  const org = useFullOrg()
  const deactivated = useDeactivated()
  const members = (org.data?.members ?? []) as readonly OrgMember[]
  return {
    members,
    deactivatedSet: deactivated.set,
    isPending: org.isPending || deactivated.isPending,
    error: org.error ?? deactivated.error,
  }
}

const ADD_MEMBER_ERRORS: Record<string, string> = {
  NO_SUCH_USER: "No user with that email — they must sign up first.",
  ALREADY_MEMBER: "That user is already a member.",
  FORBIDDEN: "Admins only.",
  EMAIL_REQUIRED: "Enter an email.",
}

/** Add an existing user to the org by email (admin-only; see router.ts). */
export async function addMemberByEmail(email: string, role: string): Promise<void> {
  const res = await fetch("/api/org/members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(ADD_MEMBER_ERRORS[body.error ?? ""] ?? body.error ?? "Failed to add member")
  }
}

/** Permanently remove a DEACTIVATED member (admin-only; see router.ts). */
export async function purgeMember(userId: string): Promise<void> {
  const res = await fetch(`/api/org/members/${userId}`, { method: "DELETE" })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    const msg =
      body.error === "NOT_DEACTIVATED"
        ? "Deactivate the member before deleting them."
        : (body.error ?? "Failed to delete member")
    throw new Error(msg)
  }
}
