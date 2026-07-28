import type { DashboardWidget } from "./api"

/**
 * The analytics widget's provider registry — the UI half of the
 * provider-agnostic design in `server/analytics.ts`.
 *
 * A provider owns its own metric list, including its own "custom query" flavor
 * and that flavor's query language. So adding a second provider is: a member in
 * the contract's `provider` literal, an entry here, and a branch in the server —
 * never a new widget type.
 *
 * The FIRST provider is the default (`newWidget` sets `provider: "posthog"`);
 * keep that in sync if the order ever changes.
 */

type Analytics = Extract<DashboardWidget, { type: "analytics" }>
export type AnalyticsProvider = Analytics["provider"]
export type AnalyticsMetric = Analytics["metric"]

export interface ProviderInfo {
  readonly id: AnalyticsProvider
  readonly label: string
}

export const PROVIDERS: ReadonlyArray<ProviderInfo> = [{ id: "posthog", label: "PostHog" }]

export interface MetricInfo {
  readonly id: AnalyticsMetric
  readonly label: string
}

/** Metric options per provider. `custom` goes last — it's the escape hatch, not
 *  a starting point, and the first entry is what a fresh widget shows. */
export const METRICS_BY_PROVIDER: Record<AnalyticsProvider, ReadonlyArray<MetricInfo>> = {
  posthog: [
    { id: "active_users", label: "Active users" },
    { id: "event_count", label: "Event count" },
    { id: "custom", label: "Custom query" },
  ],
}

/** The provider's query language, for editor labels and hints. */
export const QUERY_LANGUAGE: Record<AnalyticsProvider, string> = { posthog: "HogQL" }

/** Placeholder shown in the empty custom-query editor: the canonical shape,
 *  which doubles as documentation of the required column aliases. */
export const QUERY_PLACEHOLDER: Record<AnalyticsProvider, string> = {
  posthog: `SELECT toStartOfDay(timestamp) AS bucket,
       count() AS value,
       properties.$browser AS series
FROM events
WHERE timestamp >= {from} AND timestamp < {to}
GROUP BY bucket, series
ORDER BY bucket`,
}
