import { describe, expect, it } from "vitest"
import type { AutomationAction, SlackStatus } from "../../lib/api"
import { ACTION_OPTIONS, describeAction, emptyAction } from "./automationText"
import { readinessFor } from "./connectorReadiness"

/**
 * Drift guard for automation action kinds.
 *
 * An action kind has to be registered in eight places across six files, and only
 * ONE of them (`emptyAction`, an exhaustive switch with no default) fails the
 * build when it's missed. The rest fail silently, and the worst failure is the
 * quietest: the runner's `default` case returns "unsupported action" for forward
 * compatibility, so a half-registered kind saves fine, runs, and records a failed
 * run nobody reads.
 *
 * `ALL_KINDS` is typed as a Record over the union, so adding a kind without
 * adding it here is a COMPILE error — which converts the whole class of silent
 * drift into a loud one.
 */
const ALL_KINDS: Record<AutomationAction["kind"], true> = {
  setField: true,
  addLabel: true,
  removeLabel: true,
  createTask: true,
  createRecord: true,
  archiveRecord: true,
  notifySlack: true,
  webhook: true,
  "slack.postThreadReply": true,
  "slack.postBlocks": true,
  "slack.dmUser": true,
  "slack.addReaction": true,
  "linear.updateIssue": true,
  "linear.closeIssue": true,
  "linear.comment": true,
  "linear.assign": true,
  "linear.createIssue": true,
}

const KINDS = Object.keys(ALL_KINDS) as ReadonlyArray<AutomationAction["kind"]>

describe("automation action kinds stay in sync", () => {
  it("every kind is offerable in the editor", () => {
    // Missing here means the kind cannot be added to a rule at all, and an
    // existing rule using it renders with the raw kind string as its label.
    const offered = new Set(ACTION_OPTIONS.map((o) => o.kind))
    expect([...KINDS].filter((k) => !offered.has(k))).toEqual([])
  })

  it("ACTION_OPTIONS has no duplicate or unknown kinds", () => {
    const kinds = ACTION_OPTIONS.map((o) => o.kind)
    expect(kinds.length).toBe(new Set(kinds).size)
    expect(kinds.filter((k) => !(k in ALL_KINDS))).toEqual([])
  })

  it("every kind builds a blank action carrying its own kind", () => {
    for (const kind of KINDS) expect(emptyAction(kind).kind).toBe(kind)
  })

  it("every kind describes itself, rather than falling through to 'do something'", () => {
    // The fallthrough is a real default in `describeAction`, so this is the only
    // thing standing between a new kind and a rule that reads "do something".
    for (const kind of KINDS) {
      expect(describeAction(emptyAction(kind))).not.toBe("do something")
    }
  })

  it("kinds that call an integration declare which one", () => {
    // The editor's warning is driven entirely off `needsConnector`; a kind that
    // omits it reaches Slack/Linear with no save-time warning at all.
    for (const o of ACTION_OPTIONS) {
      const external = o.kind.startsWith("slack.") || o.kind.startsWith("linear.")
      if (external) expect(o.needsConnector).toBe(o.kind.split(".")[0])
    }
    expect(ACTION_OPTIONS.find((o) => o.kind === "notifySlack")?.needsConnector).toBe("slack")
  })
})

describe("connector readiness", () => {
  const connected: SlackStatus = {
    configured: true,
    connected: true,
    scopes: ["chat:write", "reactions:write"],
  }

  it("says nothing about actions that need no connector", () => {
    expect(readinessFor("setField", { slack: connected })).toBeNull()
    expect(readinessFor("webhook", { slack: connected })).toBeNull()
  })

  it("stays quiet while status is still loading", () => {
    // A warning that flashes on every editor open teaches people to ignore it.
    expect(readinessFor("slack.dmUser", {})).toBeNull()
  })

  it("distinguishes an unconfigured server from a disconnected workspace", () => {
    const unconfigured = readinessFor("notifySlack", {
      slack: { configured: false, connected: false },
    })
    expect(unconfigured?.level).toBe("unconfigured")
    // Nothing in Settings would help — only an operator with env access can fix it.
    expect(unconfigured?.linkToSettings).toBe(false)

    const disconnected = readinessFor("notifySlack", {
      slack: { configured: true, connected: false },
    })
    expect(disconnected?.level).toBe("disconnected")
    expect(disconnected?.linkToSettings).toBe(true)
  })

  it("flags a granted-scope gap only for the action that needs it", () => {
    const noReactions: SlackStatus = { configured: true, connected: true, scopes: ["chat:write"] }
    expect(readinessFor("slack.addReaction", { slack: noReactions })?.level).toBe("missing-scope")
    // Posting needs only chat:write, so it must not be dragged into the warning.
    expect(readinessFor("notifySlack", { slack: noReactions })).toBeNull()
    expect(readinessFor("slack.addReaction", { slack: connected })).toBeNull()
  })

  it("warns about Linear only when disconnected — it has no scopes", () => {
    expect(
      readinessFor("linear.closeIssue", { linear: { configured: true, connected: true } }),
    ).toBeNull()
    expect(
      readinessFor("linear.closeIssue", { linear: { configured: true, connected: false } })?.level,
    ).toBe("disconnected")
  })
})
