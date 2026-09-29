import { AuthRequiredError, verifyJwt } from "@atproto/xrpc-server"
import { env } from "./env.ts"
import { idResolver } from "./indexer/identity.ts"

/**
 * ATProto service auth for AppView procedures that act for a user (phase 4:
 * resume upload). The caller, normally the web BFF, asks the user's PDS for a
 * token with `com.atproto.server.getServiceAuth` and sends it as a bearer
 * token. The PDS signs it with the repo's signing key; we check it against
 * the key in the user's DID document from PLC. So the AppView trusts the
 * user's PDS, not whichever client relayed the request.
 *
 * `verifyJwt` checks the signature, expiry, audience (our DID) and `lxm` (the
 * one method the token is good for). We also reject a replayed `jti`, which
 * makes each token single-use.
 */

/** jti → expiry (unix seconds), kept until the token would have expired. */
const usedNonces = new Map<string, number>()

export type AuthResult = { did: string } | { error: string; message: string }

export async function verifyServiceAuth(
  authorization: string | undefined,
  lxm: string
): Promise<AuthResult> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1]
  if (!token) {
    return { error: "AuthMissing", message: "Service auth token required" }
  }
  try {
    const payload = await verifyJwt(
      token,
      env.SERVICE_DID,
      lxm,
      async (iss, forceRefresh) =>
        idResolver.did.resolveAtprotoKey(iss.split("#")[0]!, forceRefresh)
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
    return { did: payload.iss.split("#")[0]! }
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return {
        error: err.customErrorName ?? "AuthRequired",
        message: err.errorMessage ?? "Invalid service auth token",
      }
    }
    // DID resolution failures and the like: still an auth failure to the caller.
    return {
      error: "AuthRequired",
      message: "Could not verify service auth token",
    }
  }
}
