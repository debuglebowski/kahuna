import { isIP } from "node:net"

/**
 * The client address, as the reverse proxy in front of Kahuna reports it. Feeds
 * BetterAuth's rate limiter (via `CLIENT_IP_HEADER`) and the security log's `ip`.
 *
 * WHY THE RIGHTMOST ENTRY. A proxy either overwrites `X-Forwarded-For` (the bundled
 * Caddyfile does) or APPENDS the address it saw to whatever the client sent (Azure
 * Container Apps ingress, nginx's `$proxy_add_x_forwarded_for`, most load
 * balancers). Either way the entries a client controls are on the LEFT, and only
 * the ones our own proxies appended — counted from the right — are facts. Seen on
 * ACA: a request sent with `X-Forwarded-For: 203.0.113.3` arrives as
 * `203.0.113.3, <real client>`, and taking the first entry logged the spoofed one.
 *
 * `TRUSTED_PROXY_HOPS` is how many proxies append to the header: 1 for ACA ingress
 * or the bundled Caddy (the default). A proxying CDN in front of either (Cloudflare
 * orange-cloud, Front Door) makes it 2 — leave it at 1 there and every client
 * shares the CDN's handful of edge addresses, i.e. one rate-limit bucket.
 */
const parseHops = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return 1
  const n = Number(raw)
  // Fail the boot rather than guess: a wrong hop count either trusts a spoofable
  // entry or collapses everyone into the proxy's address.
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`TRUSTED_PROXY_HOPS must be a positive integer, got "${raw}"`)
  return n
}
export const TRUSTED_PROXY_HOPS = parseHops(process.env.TRUSTED_PROXY_HOPS)

/** `198.51.100.4:443` / `[2001:db8::1]:443` → the address. Some proxies append the source port. */
const bareAddress = (entry: string): string => {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry)
  if (bracketed?.[1]) return bracketed[1]
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(entry)
  return v4WithPort?.[1] ?? entry
}

/**
 * The `hops`-th `X-Forwarded-For` entry from the right, or null. Null when the
 * chain is shorter than the proxy count — the request skipped a proxy we rely on,
 * so nothing in the header was written by one — and for anything that is not an
 * address (which also stops a header smuggling a log line through).
 */
export const clientIp = (
  headers: Headers | undefined | null,
  hops: number = TRUSTED_PROXY_HOPS,
): string | null => {
  const chain = headers?.get("x-forwarded-for")?.split(",")
  const entry = chain?.[chain.length - hops]?.trim()
  if (!entry) return null
  const ip = bareAddress(entry)
  return isIP(ip) ? ip : null
}

/**
 * Where the resolved address is handed to BetterAuth (`advanced.ipAddress` in
 * auth.ts). BetterAuth cannot be pointed at the rightmost entry itself: it reads
 * the LEFTMOST `X-Forwarded-For` value (1.6.14), or refuses any multi-value chain
 * and falls back to one bucket shared by every client (1.6.22). So the server
 * resolves it once and passes a single value under a name of its own.
 */
export const CLIENT_IP_HEADER = "x-kahuna-client-ip"

/**
 * `req` with `CLIENT_IP_HEADER` set from `clientIp`. Any copy the client sent is
 * dropped first — the header is only meaningful because the server wrote it.
 */
export const withClientIpHeader = (req: Request): Request => {
  const headers = new Headers(req.headers)
  headers.delete(CLIENT_IP_HEADER)
  const ip = clientIp(req.headers)
  if (ip) headers.set(CLIENT_IP_HEADER, ip)
  return new Request(req, { headers })
}
