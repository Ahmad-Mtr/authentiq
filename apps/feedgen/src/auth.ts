import { IdResolver, MemoryCache } from "@atproto/identity"
import { AuthRequiredError, verifyJwt } from "@atproto/xrpc-server"
import {
  createGuardedFetch,
  parseAllowlist,
} from "@workspace/atproto/fetch-guard"
import { sh } from "@workspace/lexicons"
import { env } from "./env.ts"

/**
 * Who is asking, for personalised feeds (phase 8). Bluesky's model: the
 * viewer's PDS signs a service auth token with `aud` = this generator's DID
 * and `lxm` = getFeedSkeleton, and the AppView forwards it unchanged. It is
 * verified here, not trusted because the AppView checked it:
 *
 * - the signature, against the signing key in the issuer's DID document
 *   (PLC, through the fetch guard: `iss` is whatever the caller wrote);
 * - `aud` is this service, so a token for the AppView or another generator
 *   is refused;
 * - `lxm` is getFeedSkeleton, and the token has not expired;
 * - its `jti` has not been seen before: each token works once here. (The
 *   AppView keeps its own list, so the one forwarded hop is fine.)
 *
 * No header means an anonymous request, which each feed answers as it
 * documents. A header that fails any check is a 401, never anonymous.
 */

const LXM = sh.authentiq.feed.getFeedSkeleton.$lxm

const plc = new URL(env.PLC_URL)
const idResolver = new IdResolver({
  plcUrl: env.PLC_URL,
  didCache: new MemoryCache(),
  fetch: createGuardedFetch({
    allow: parseAllowlist([
      `${plc.hostname}:${plc.port || (plc.protocol === "https:" ? 443 : 80)}`,
    ]),
    timeoutMs: 3000,
    maxBytes: 64 * 1024,
  }),
})

/** jti → expiry (unix seconds), kept until the token would have expired. */
const usedNonces = new Map<string, number>()

export type ViewerAuth =
  | { viewer: string | undefined }
  | { error: string; message: string }

export async function verifyViewer(
  authorization: string | undefined
): Promise<ViewerAuth> {
  if (!authorization) return { viewer: undefined }
  const token = authorization.match(/^Bearer (.+)$/)?.[1]
  if (!token) return { error: "BadJwt", message: "Expected a Bearer token" }
  try {
    const payload = await verifyJwt(token, env.SERVICE_DID, LXM, (iss, force) =>
      idResolver.did.resolveAtprotoKey(iss.split("#")[0]!, force)
    )
    const now = Date.now() / 1000
    for (const [jti, exp] of usedNonces) if (exp < now) usedNonces.delete(jti)
    if (!payload.jti || usedNonces.has(payload.jti)) {
      return {
        error: "BadJwt",
        message: "Token is missing a nonce or was already used",
      }
    }
    usedNonces.set(payload.jti, payload.exp)
    return { viewer: payload.iss.split("#")[0]! }
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return {
        error: err.customErrorName ?? "AuthRequired",
        message: err.errorMessage ?? "Invalid service auth token",
      }
    }
    return { error: "AuthRequired", message: "Could not verify the token" }
  }
}
