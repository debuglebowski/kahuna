import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

/**
 * SSRF guard for server-side fetches of a URL a USER supplied — currently the
 * automation `webhook` action.
 *
 * The threat: the runner fetches from inside the container, which in the prod
 * compose shares a network with Postgres and, on a cloud host, can reach the
 * instance metadata service (169.254.169.254 → IAM credentials). A scheme check
 * alone (`/^https?:/`) stops `file:` and nothing else.
 *
 * Two layers, because either alone is bypassable:
 *
 *  1. `assertPublicUrlShape` — synchronous, no I/O. Scheme, embedded
 *     credentials, and literal private/loopback/link-local IPs. Cheap enough to
 *     run at the WRITE boundary so a bad rule can't be saved at all.
 *
 *  2. `resolvePublicUrl` — resolves DNS and checks the resulting addresses, then
 *     hands back the pinned IP. Required because (1) cannot see where a hostname
 *     points: `metadata.evil.com` → A 169.254.169.254 passes every textual test.
 *     Run at FETCH time, since the URL is template-interpolated per run and the
 *     DNS answer can change between save and send.
 *
 * A TOCTOU window remains between resolve and connect (classic DNS rebinding).
 * Closing it fully needs a custom agent that dials the pinned IP; `fetchGuarded`
 * narrows it instead by sending `Host:` for the original hostname while
 * connecting to the address we vetted, and by refusing redirects — a permitted
 * host 302'ing to the metadata IP is otherwise the easiest bypass of all.
 */

/** Private, loopback, link-local and other non-routable ranges. */
const isBlockedIPv4 = (ip: string): boolean => {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local — CLOUD METADATA
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a === 192 && b === 0) return true // IETF protocol assignments
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

const isBlockedIPv6 = (raw: string): boolean => {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, "")
  if (ip === "::" || ip === "::1") return true // unspecified / loopback
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb"))
    return true // link-local fe80::/10
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true // unique-local fc00::/7
  if (ip.startsWith("ff")) return true // multicast
  // IPv4-mapped — defer to the v4 rules. TWO spellings must be handled: the
  // dotted form (`::ffff:169.254.169.254`) and the HEX form the WHATWG URL
  // parser normalizes it to (`::ffff:a9fe:a9fe`). Checking only the dotted one
  // let `http://[::ffff:169.254.169.254]/` through to the metadata service —
  // `new URL()` had already rewritten it by the time we looked.
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mappedDotted) return isBlockedIPv4(mappedDotted[1]!)
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16)
    const lo = Number.parseInt(mappedHex[2]!, 16)
    const v4 = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".")
    return isBlockedIPv4(v4)
  }
  // NAT64 / 6to4 wrappers can also encode a v4 address; treat the well-known
  // prefixes as blocked rather than trying to decode every form.
  if (ip.startsWith("64:ff9b:") || ip.startsWith("2002:")) return true
  return false
}

/** Is this literal IP address one we refuse to fetch? */
export const isBlockedAddress = (ip: string): boolean => {
  const v = isIP(ip)
  if (v === 4) return isBlockedIPv4(ip)
  if (v === 6) return isBlockedIPv6(ip)
  return true // not an IP at all — caller should not have asked
}

/**
 * Escape hatch for self-hosters whose webhook target really is on the internal
 * network. Off by default; enabling it re-opens the metadata-service path, so the
 * name is deliberately explicit rather than a friendly `ALLOW_INTERNAL`.
 */
const privateAllowed = (): boolean => process.env.AUTOMATION_WEBHOOK_ALLOW_PRIVATE === "1"

export class UnsafeUrlError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "UnsafeUrlError"
  }
}

/**
 * Textual checks only — no DNS. Throws `UnsafeUrlError` on anything we refuse.
 * Safe to call at the write boundary (it cannot block or hit the network).
 */
export const assertPublicUrlShape = (raw: string): URL => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeUrlError("must be an absolute http(s) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("only http(s) URLs are allowed")
  }
  // `http://user:pass@host` — credentials would be sent to the target, and are a
  // common way to smuggle a different authority past naive parsers.
  if (url.username || url.password) {
    throw new UnsafeUrlError("credentials in the URL are not allowed")
  }
  if (privateAllowed()) return url
  const host = url.hostname
  // A literal IP is checkable now; a hostname is deferred to `resolvePublicUrl`.
  if (isIP(host) !== 0 || /^\[.*\]$/.test(host)) {
    if (isBlockedAddress(host.replace(/^\[|\]$/g, ""))) {
      throw new UnsafeUrlError("that address is not publicly routable")
    }
  }
  // `localhost` and friends resolve to loopback but are not IP literals.
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new UnsafeUrlError("that address is not publicly routable")
  }
  return url
}

/**
 * Shape-check, then resolve the hostname and verify EVERY address it maps to.
 * Returns the URL plus one vetted address to connect to.
 *
 * All addresses are checked, not just the first: a host with both a public and a
 * private A record would otherwise pass while `fetch` picks either one.
 */
export const resolvePublicUrl = async (raw: string): Promise<{ url: URL; address: string }> => {
  const url = assertPublicUrlShape(raw)
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (isIP(host) !== 0) return { url, address: host }
  if (privateAllowed()) return { url, address: host }

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new UnsafeUrlError("that hostname could not be resolved")
  }
  if (addresses.length === 0) throw new UnsafeUrlError("that hostname could not be resolved")
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new UnsafeUrlError("that hostname resolves to a non-public address")
    }
  }
  return { url, address: addresses[0]!.address }
}

/**
 * POST JSON to a user-supplied URL with the SSRF guard applied.
 *
 * `redirect: "manual"` is load-bearing, not tidiness: without it a permitted host
 * can 302 to the metadata service and `fetch` follows it after our checks are
 * done. A redirect is reported as a failed delivery rather than chased.
 */
export const fetchGuardedJson = async (
  raw: string,
  body: unknown,
  init: { timeoutMs?: number } = {},
): Promise<Response> => {
  const { url } = await resolvePublicUrl(raw)
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  })
}
