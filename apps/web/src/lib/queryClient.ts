import { QueryClient } from "@tanstack/react-query"

/**
 * The single QueryClient, shared by the React provider (main.tsx) AND the
 * TanStack DB query collections (collections.ts) — they must use the same
 * instance so a collection's `utils.refetch()` and the app's queries agree.
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: false } },
})
