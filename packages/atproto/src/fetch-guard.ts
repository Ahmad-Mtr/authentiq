/**
 * The one place outbound requests to user-named URLs go through (phase 8).
 *
 * Records name network locations: a feed generator record names a DID, a
 * did:web names a host, a DID document names a service endpoint, and a
 * service auth token's `iss` names a DID to fetch a key for. Anyone can
 * write those, so fetching them unguarded lets anyone make our services
 * request `http://169.254.169.254/…` or a database port on our network.
 *
 * Every such request is checked before a connection is made:
 *
 * - **Scheme.** https only. http is allowed only for a host on the allowlist.
 * - **Address.** The host is resolved (or read, if it is an IP literal) and
 *   every address must be public unicast. Loopback, private (RFC 1918),
 *   link-local (including the 169.254.169.254 metadata address), CGNAT,
 *   unique-local, multicast, documentation and reserved ranges are refused,
 *   as are IPv4 addresses hidden in IPv6 (mapped, NAT64, 6to4, Teredo).
 * - **Allowlist, for development.** An exact `host:port` (or `host:lo-hi`)
 *   on the allowlist skips the address check, so the local feed generators
 *   (`localhost:2585`, `localhost:2586`) work. It is ports, not hosts:
 *   allowing `localhost:2585` does not open `localhost:5442` (Postgres).
 * - **No redirects**, a timeout, and a cap on the response size.
 *
 * It is not proof against DNS rebinding: the address is checked, then fetch
 * resolves the name again to connect. Pinning the checked address needs a
 * custom connector (see the phase 8 doc, known gaps).
 *
 * Server-only (node:dns). Import it as `@workspace/atproto/fetch-guard`, never
 * from the package index, which the browser bundle uses.
 */
import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"

export class BlockedUrlError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string
  ) {
    super(`Refused to fetch ${url}: ${reason}`)
    this.name = "BlockedUrlError"
  }
}

export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response is larger than ${maxBytes} bytes`)
    this.name = "ResponseTooLargeError"
  }
}

const blocked = new BlockList()
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, bits, "ipv4")
}
for (const [net, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, bits, "ipv6")
}

/** The IPv4 address an IPv6 address carries, for the forms that carry one. */
function embeddedIpv4(address: string): string | undefined {
  const a = address.toLowerCase()
  // ::ffff:a.b.c.d (mapped) and 64:ff9b::a.b.c.d (NAT64), dotted form.
  const dotted = a.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]
  const groups = expandIpv6(a)
  if (!groups) return undefined
  const v4 = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  const zeros = (n: number) => groups.slice(0, n).every((g) => g === 0)
  // ::ffff:0:0/96 mapped, 64:ff9b::/96 NAT64
  if (zeros(5) && groups[5] === 0xffff) return v4(groups[6]!, groups[7]!)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return v4(groups[6]!, groups[7]!)
  }
  // 2002::/16 6to4: the next 32 bits
  if (groups[0] === 0x2002) return v4(groups[1]!, groups[2]!)
  // 2001::/32 Teredo: the client address, inverted, in the last 32 bits
  if (groups[0] === 0x2001 && groups[1] === 0) {
    return v4(groups[6]! ^ 0xffff, groups[7]! ^ 0xffff)
  }
  return undefined
}

function expandIpv6(a: string): Array<number> | undefined {
  if (a.includes(".")) return undefined
  const [head, tail] = a.split("::") as [string, string | undefined]
  const parse = (s: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : [])
  const h = parse(head)
  const t = tail === undefined ? [] : parse(tail)
  const fill = 8 - h.length - t.length
  if (fill < 0 || (tail === undefined && fill !== 0)) return undefined
  const groups = [...h, ...Array<number>(fill).fill(0), ...t]
  return groups.some((g) => !Number.isFinite(g)) ? undefined : groups
}

/** Why an address may not be fetched, or undefined if it is public unicast. */
export function blockedAddressReason(address: string): string | undefined {
  const family = isIP(address)
  if (family === 0) return "not an IP address"
  if (family === 4) {
    return blocked.check(address, "ipv4")
      ? `${address} is in a private, loopback, link-local or reserved range`
      : undefined
  }
  if (blocked.check(address, "ipv6")) {
    return `${address} is in a private, loopback, link-local or reserved range`
  }
  const v4 = embeddedIpv4(address)
  if (v4 && blocked.check(v4, "ipv4")) {
    return `${address} carries ${v4}, which is in a private, loopback, link-local or reserved range`
  }
  return undefined
}

/** `host:port` and `host:lo-hi` entries. The port is always explicit. */
export function parseAllowlist(entries: string | Iterable<string>) {
  const list = typeof entries === "string" ? entries.split(",") : [...entries]
  return list.flatMap((raw) => {
    const e = raw.trim().toLowerCase()
    const m = e.match(/^(.+):(\d+)(?:-(\d+))?$/)
    if (!m) return []
    const lo = Number(m[2])
    return [{ host: m[1]!, lo, hi: m[3] ? Number(m[3]) : lo }]
  })
}
export type Allowlist = ReturnType<typeof parseAllowlist>

const defaultPort = (url: URL) =>
  Number(url.port || (url.protocol === "https:" ? 443 : 80))

function isAllowlisted(url: URL, allow: Allowlist) {
  const host = url.hostname.toLowerCase()
  const port = defaultPort(url)
  return allow.some((a) => a.host === host && port >= a.lo && port <= a.hi)
}

/**
 * Throws BlockedUrlError unless `url` may be fetched. Makes no connection:
 * at most a DNS lookup.
 */
export async function checkUrl(input: string | URL, allow: Allowlist = []) {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new BlockedUrlError(String(input), "not a URL")
  }
  const shown = url.origin
  if (url.username || url.password) {
    throw new BlockedUrlError(shown, "credentials in the URL")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedUrlError(shown, `scheme ${url.protocol} is not allowed`)
  }
  if (isAllowlisted(url, allow)) return url
  if (url.protocol !== "https:") {
    throw new BlockedUrlError(shown, "http is only allowed for allowlisted hosts")
  }
  // URL keeps IPv6 literals in brackets.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1")
  let addresses: Array<string>
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map(
        (r) => r.address
      )
    } catch {
      throw new BlockedUrlError(shown, `${host} does not resolve`)
    }
  }
  for (const address of addresses) {
    const reason = blockedAddressReason(address)
    if (reason) throw new BlockedUrlError(shown, reason)
  }
  return url
}

export type GuardOptions = {
  allow?: Allowlist
  /** Per request. Default 5 s. */
  timeoutMs?: number
  /** Response bodies past this are refused. Default 1 MiB. */
  maxBytes?: number
  /** Called when a URL is refused, before the error is thrown. */
  onBlocked?: (err: BlockedUrlError) => void
}

/** Reads a response body, failing once it passes `max` bytes. */
export async function readCapped(res: Response, max: number) {
  const declared = Number(res.headers.get("content-length") ?? 0)
  if (declared > max) {
    await res.body?.cancel().catch(() => {})
    throw new ResponseTooLargeError(max)
  }
  if (!res.body) return new Uint8Array()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.byteLength
    if (size > max) {
      await res.body.cancel().catch(() => {})
      throw new ResponseTooLargeError(max)
    }
    chunks.push(chunk)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/**
 * A fetch with the checks above: refuses blocked URLs before connecting,
 * never follows a redirect, times out, and buffers at most `maxBytes` of the
 * body. Suitable for `IdResolver({ fetch })`, which otherwise either refuses
 * `did:web:localhost` (its default fetch, under Node) or checks nothing (the
 * global fetch).
 */
export function createGuardedFetch(opts: GuardOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000
  const maxBytes = opts.maxBytes ?? 1024 * 1024
  return async function guardedFetch(
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> {
    const target = input instanceof Request ? input.url : input
    let url: URL
    try {
      url = await checkUrl(target, opts.allow)
    } catch (err) {
      if (err instanceof BlockedUrlError) opts.onBlocked?.(err)
      throw err
    }
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)
    const res = await fetch(url, { ...init, redirect: "manual", signal })
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      throw new BlockedUrlError(url.origin, "redirects are not followed")
    }
    const body = await readCapped(res, maxBytes)
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}
