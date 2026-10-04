import type { AutomationAction, LinearStatus, SlackStatus } from "../../lib/api"
import { ACTION_OPTIONS, type ActionConnector } from "./automationText"

/**
 * Whether the integrations an automation's actions depend on are actually ready,
 * and what to tell the user when they are not.
 *
 * Deliberately advisory: nothing here blocks a save. An admin can revoke a token
 * long after a rule was written, so the run-time path has to handle a missing
 * connector regardless — which makes a save-time block a second, weaker copy of a
 * guard that already exists, at the cost of trapping someone in an editor they
 * can't leave. The editor's job is to make sure the failure isn't a surprise.
 */

export type ReadinessLevel = "ok" | "unconfigured" | "disconnected" | "missing-scope"

export interface Readiness {
  readonly level: ReadinessLevel
  readonly connector: ActionConnector
  /** One line, imperative where the reader can act. */
  readonly title: string
  readonly detail: string
  /** Whether Settings → Integrations would actually help. False when only an
   *  operator with server env access can fix it. */
  readonly linkToSettings: boolean
}

const LABEL: Record<ActionConnector, string> = { slack: "Slack", linear: "Linear" }

/** The connector + extra scope an action kind needs, from the single catalog. */
const requirementFor = (kind: AutomationAction["kind"]) => {
  const meta = ACTION_OPTIONS.find((o) => o.kind === kind)
  return meta?.needsConnector ? { connector: meta.needsConnector, scope: meta.needsScope } : null
}

/**
 * Assess one action against the live connector status.
 *
 * `undefined` status means "still loading" and reads as ready — a warning that
 * flashes on every editor open would train people to ignore it.
 */
export const readinessFor = (
  kind: AutomationAction["kind"],
  status: { slack?: SlackStatus; linear?: LinearStatus },
): Readiness | null => {
  const need = requirementFor(kind)
  if (!need) return null
  const name = LABEL[need.connector]

  if (need.connector === "linear") {
    const s = status.linear
    if (!s) return null
    // Linear is key-based: `configured` is hardcoded true and there are no
    // scopes — a personal API key carries its owner's full access. So the only
    // failure worth warning about is "not connected".
    if (!s.connected) {
      return {
        level: "disconnected",
        connector: "linear",
        title: `${name} isn't connected`,
        detail: "This action will be recorded as failed on every run until it is.",
        linkToSettings: true,
      }
    }
    return null
  }

  const s = status.slack
  if (!s) return null
  if (!s.configured) {
    return {
      level: "unconfigured",
      connector: "slack",
      // No CTA: this one is not fixable from the app at all.
      title: `${name} isn't set up on this server`,
      detail:
        "An operator needs to add the Slack app credentials before this workspace can connect.",
      linkToSettings: false,
    }
  }
  if (!s.connected) {
    return {
      level: "disconnected",
      connector: "slack",
      title: `${name} isn't connected`,
      detail: "This action will be recorded as failed on every run until it is.",
      linkToSettings: true,
    }
  }
  if (need.scope && !(s.scopes ?? []).includes(need.scope)) {
    return {
      level: "missing-scope",
      connector: "slack",
      title: `Slack hasn't granted ${need.scope}`,
      // The re-authorize wording matters: the scope is in our request list, so
      // "connected" looks fine — it is the workspace's stored grant that is old.
      detail: `Reconnect Slack to add it. Workspaces that installed Kahuna before ${need.scope} was introduced keep their original permissions until someone re-authorizes.`,
      linkToSettings: true,
    }
  }
  return null
}

/** Every distinct problem across a rule's actions, deduped by connector+level so
 *  four Slack actions on a disconnected workspace warn once, not four times. */
export const readinessForActions = (
  actions: ReadonlyArray<AutomationAction>,
  status: { slack?: SlackStatus; linear?: LinearStatus },
): ReadonlyArray<Readiness> => {
  const byKey = new Map<string, Readiness>()
  for (const a of actions) {
    const r = readinessFor(a.kind, status)
    if (r) byKey.set(`${r.connector}:${r.level}`, r)
  }
  return [...byKey.values()]
}
