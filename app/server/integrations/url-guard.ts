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
 *     credentials, and literal private/loopback/link-local IPs.
 *
 *  2. `resolvePublicUrl` — resolves DNS and checks the resulting addresses.
 *     Required because (1) cannot see where a hostname points:
 *     `metadata.evil.com` → A 169.254.169.254 passes every textual test.
 *
 * Both run at FETCH time, (1) via (2): the URL is template-interpolated per run,
 * so there is no useful save-time string to check here. The save boundary has its
 * own textual screen — `AutomationService.webhookUrlProblem` in the engine, which
 * cannot import this file — and that one is UX, not the security boundary. This
 * is the security boundary.
 *
 * A TOCTOU window remains between resolve and connect (classic DNS rebinding).
 * `resolvePublicUrl` hands back a vetted address for a caller that wants to pin
 * it, but `fetchGuardedJson` does NOT — it re-dials the hostname, so the window
 * is real. Closing it needs a custom dispatcher that connects to the pinned IP
 * while sending `Host:` for the original name. What IS live is `redirect:
 * "manual"`: a permitted host 302'ing to the metadata IP is the easiest bypass of
 * all, and that one is closed.
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

/**
 * Decode an IPv4-mapped IPv6 address to its dotted form, or null.
 *
 * TWO spellings must be handled: the dotted form (`::ffff:169.254.169.254`) and
 * the HEX form the WHATWG URL parser normalizes it to (`::ffff:a9fe:a9fe`).
 * Checking only the dotted one let `http://[::ffff:169.254.169.254]/` through to
 * the metadata service — `new URL()` had already rewritten it by the time we
 * looked.
 */
const mappedIPv4 = (ip: string): string | null => {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (dotted) return dotted[1]!
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (!hex) return null
  const hi = Number.parseInt(hex[1]!, 16)
  const lo = Number.parseInt(hex[2]!, 16)
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".")
}

const isBlockedIPv6 = (raw: string): boolean => {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, "")
  if (ip === "::" || ip === "::1") return true // unspecified / loopback
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb"))
    return true // link-local fe80::/10
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true // unique-local fc00::/7
  if (ip.startsWith("ff")) return true // multicast
  const mapped = mappedIPv4(ip) // IPv4-mapped — defer to the v4 rules
  if (mapped) return isBlockedIPv4(mapped)
  // NAT64 / 6to4 wrappers can also encode a v4 address; treat the well-known
  // prefixes as blocked rather than trying to decode every form.
  if (ip.startsWith("64:ff9b:") || ip.startsWith("2002:")) return true
  return false
}

/**
 * The cloud instance metadata service: 169.254.169.254 on AWS, GCP, Azure and
 * DigitalOcean, plus fd00:ec2::254 on IPv6-only EC2.
 *
 * Split out from `isBlockedIPv4`/`isBlockedIPv6` because this subset is refused
 * EVEN WHEN the private-network escape hatch is on (see `privateAllowed`).
 * Everything else that hatch re-opens is a machine on the operator's own network;
 * this one hands out IAM credentials for the whole cloud account, and no real
 * webhook target lives there. The rest of 169.254.0.0/16 goes with it — nothing
 * routable is in that range either, so keeping it costs no legitimate target.
 *
 * Narrow on purpose: 6to4/NAT64 spellings of the same address are not decoded
 * here. They are blocked wholesale when the hatch is off, and cannot reach the
 * metadata service without a relay when it is on.
 */
export const isMetadataAddress = (raw: string): boolean => {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, "")
  const v4 = isIP(ip) === 4 ? ip : mappedIPv4(ip)
  if (v4) {
    const [a, b] = v4.split(".").map(Number)
    return a === 169 && b === 254
  }
  return ip === "fd00:ec2::254"
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
 * network. Off by default, and an exact `"1"` — `true`/`yes` do NOT enable it,
 * which is the right direction to fail for a flag that widens what we will fetch.
 *
 * It re-opens loopback, RFC1918 and unique-local, but NOT the metadata service:
 * see `isMetadataAddress`. The name stays explicit rather than a friendly
 * `ALLOW_INTERNAL` because it is still a real widening.
 *
 * NOTE: the engine's save-time screen (`AutomationService.webhookUrlProblem`)
 * cannot read this — it is sync and env-free — so a rule targeting a LITERAL
 * private IP is refused in the editor whether or not this is set. Hostnames are
 * unaffected, which is the shape a compose-network target normally has
 * (`http://n8n:5678`). Documented in `.env.production.example`.
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
  const host = url.hostname
  // A literal IP is checkable now; a hostname is deferred to `resolvePublicUrl`.
  const literal = isIP(host) !== 0 || /^\[.*\]$/.test(host)
  const bare = host.replace(/^\[|\]$/g, "")
  // Before the escape hatch, not after: this one is refused either way.
  if (literal && isMetadataAddress(bare)) {
    throw new UnsafeUrlError("that address is the cloud metadata service")
  }
  if (privateAllowed()) return url
  if (literal && isBlockedAddress(bare)) {
    throw new UnsafeUrlError("that address is not publicly routable")
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
  // A literal address was fully vetted by the shape check above.
  if (isIP(host) !== 0) return { url, address: host }

  // The escape hatch does NOT skip resolution. `metadata.evil.com` → A
  // 169.254.169.254 is the whole reason this layer exists, and it works just as
  // well against a deployment that allows its own private network. The cost is
  // that an unresolvable host now fails here rather than at `fetch` — same
  // outcome, earlier and with a clearer message.
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new UnsafeUrlError("that hostname could not be resolved")
  }
  if (addresses.length === 0) throw new UnsafeUrlError("that hostname could not be resolved")
  const allowPrivate = privateAllowed()
  for (const { address } of addresses) {
    if (isMetadataAddress(address)) {
      throw new UnsafeUrlError("that hostname resolves to the cloud metadata service")
    }
    if (!allowPrivate && isBlockedAddress(address)) {
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
 *
 * The vetted address from `resolvePublicUrl` is deliberately unused: `fetch` has
 * no connect-time hook, so dialing it would mean a custom dispatcher. The
 * rebinding window that leaves open is documented at the top of this file.
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
