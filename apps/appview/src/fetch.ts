import {
  createGuardedFetch,
  parseAllowlist,
} from "@workspace/atproto/fetch-guard"
import { env } from "./env.ts"

/**
 * Every AppView request to a location a user can name goes through this
 * fetch (phase 8): DID documents (did:web hosts, from records and from
 * service auth tokens' `iss`), handle checks against the PDS a DID document
 * names, and feed generator endpoints. The rules are in
 * packages/atproto/src/fetch-guard.ts.
 *
 * PLC and the local PDS are configuration, not user input, so their hosts are
 * allowed. `FETCH_ALLOW` adds the local feed generators for development.
 */
const hostOf = (url: string) => {
  const u = new URL(url)
  return `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`
}

export const fetchAllowlist = parseAllowlist([
  hostOf(env.PLC_URL),
  hostOf(env.PDS_URL),
  ...env.FETCH_ALLOW.split(","),
])

export const guardedFetch = createGuardedFetch({
  allow: fetchAllowlist,
  timeoutMs: 5000,
  maxBytes: 1024 * 1024,
  onBlocked: (err) =>
    console.warn(`[fetch-guard] refused ${err.url}: ${err.reason}`),
})

/**
 * The same guard with tighter limits, for `getFeedSkeleton` calls: a
 * skeleton is a list of URIs, and a slow generator must not hold a request.
 */
export const feedFetch = createGuardedFetch({
  allow: fetchAllowlist,
  timeoutMs: 3000,
  maxBytes: 256 * 1024,
  onBlocked: (err) =>
    console.warn(`[fetch-guard] refused ${err.url}: ${err.reason}`),
})
