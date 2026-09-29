import {
  createGuardedFetch,
  parseAllowlist,
} from "@workspace/atproto/fetch-guard"
import { env } from "./env.ts"

/**
 * The fetch guard (packages/atproto/src/fetch-guard.ts) for the BFF's own
 * lookups of user-named locations: the DID and PDS behind a record URI that
 * a request names (a reply's parent, a liked post). PLC and the local PDS
 * are configuration, so they are allowed; nothing else on the local network
 * is. Server-only.
 */
const hostOf = (url: string) => {
  const u = new URL(url)
  return `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`
}

export const guardedFetch = createGuardedFetch({
  allow: parseAllowlist([hostOf(env.PLC_URL), hostOf(env.PDS_URL)]),
  timeoutMs: 5000,
  maxBytes: 1024 * 1024,
  onBlocked: (err) =>
    console.warn(`[fetch-guard] refused ${err.url}: ${err.reason}`),
})
