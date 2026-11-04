import { useQuery } from "@tanstack/react-query"
import { api } from "./api"

/** The org's data defaults (member-readable). `defaultCurrency` is null when
 *  unset — callers must then ask for a currency, never assume one. */
export function useOrgSettings() {
  const q = useQuery({ queryKey: ["orgSettings"], queryFn: () => api.getOrgSettings() })
  return { ...q, defaultCurrency: q.data?.defaultCurrency ?? null }
}

/** What a money input resolves its currency from when the writer typed none:
 *  the value's own current currency, else the org default. Null = nothing to
 *  fall back on, so the caller must refuse rather than stamp a guess. */
export const fallbackCurrency = (stored: unknown, orgDefault: string | null): string | null => {
  const cur = (stored as { currency?: unknown } | null)?.currency
  return typeof cur === "string" && cur ? cur : orgDefault
}
