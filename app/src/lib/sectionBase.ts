import { useLocation } from "react-router-dom"

/**
 * Sections that render at TWO urls — once as a top-level app page (`/members`),
 * once inside settings (`/settings/members`) — with one implementation behind
 * both.
 *
 * The problem this solves: those pages and their shared components link to
 * themselves (a directory row → a profile, an editor's breadcrumb → its list).
 * Hardcoding `/members` means a click inside `/settings/members` silently throws
 * the user out of settings. So links have to be built from wherever the section
 * is currently mounted, not from a constant.
 */
export type DualSection = "members" | "automations"

/** Is this path inside settings? Matches `/settings` and `/settings/…` but NOT a
 *  lookalike sibling like `/settings-export`, which a bare `startsWith` would
 *  wrongly claim (and then build broken links from). Pure — see the hook below. */
export const isSettingsPath = (pathname: string): boolean =>
  pathname === "/settings" || pathname.startsWith("/settings/")

/** The prefix `section` is mounted under for this path: `/settings/members`
 *  inside settings, `/members` outside. Pure, so it is unit-testable without a
 *  router or a DOM (this project's test setup has neither). */
export const sectionBaseFor = (pathname: string, section: DualSection): string =>
  `${isSettingsPath(pathname) ? "/settings" : ""}/${section}`

/** Is the current route inside settings? */
export const useInSettings = (): boolean => isSettingsPath(useLocation().pathname)

/**
 * The path prefix this section is mounted under right now. Build every self-link
 * from it.
 *
 * Deliberately derived from the URL rather than passed as a prop: the shared
 * pieces (`MemberDirectory`, reused by a dashboard widget) sit several levels
 * below the route and would otherwise need the base threaded through every
 * caller, including ones that have no opinion about it.
 */
export const useSectionBase = (section: DualSection): string =>
  sectionBaseFor(useLocation().pathname, section)
