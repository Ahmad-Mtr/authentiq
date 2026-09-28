import { NodeOAuthClient, requestLocalLock } from "@atproto/oauth-client-node"
import type {
  NodeSavedSession,
  NodeSavedState,
} from "@atproto/oauth-client-node"
import { eq } from "drizzle-orm"
import { db, schema } from "./db.ts"
import { env } from "./env.ts"

const SCOPE = "atproto transition:generic"
const redirectUri = `${env.WEB_ORIGIN}/api/oauth/callback`

/**
 * Development uses an ATProto *loopback* client: the `client_id` is a
 * `http://localhost` URL carrying the redirect URI and scope, which the
 * authorization server accepts without fetching client metadata. A deployed
 * Authentiq would instead host `client-metadata.json` over HTTPS.
 *
 * Loopback redirects must use 127.0.0.1 (or [::1]), never the hostname
 * "localhost" — hence WEB_ORIGIN.
 */
const clientId = `http://localhost?redirect_uri=${encodeURIComponent(
  redirectUri
)}&scope=${encodeURIComponent(SCOPE)}`

export const oauthClient = new NodeOAuthClient({
  // Single-process dev server: an in-process lock is enough to stop concurrent
  // refreshes from revoking each other's credentials.
  requestLock: requestLocalLock,
  clientMetadata: {
    client_id: clientId,
    client_name: "Authentiq",
    redirect_uris: [redirectUri],
    scope: SCOPE,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "native",
    token_endpoint_auth_method: "none",
    dpop_bound_access_tokens: true,
  },

  // The local network speaks http and runs its own PLC directory.
  allowHttp: true,
  plcDirectoryUrl: env.PLC_URL,
  // `*.test` handles have no DNS or /.well-known, so resolve them through the
  // PDS's com.atproto.identity.resolveHandle instead.
  handleResolver: env.PDS_URL,

  stateStore: {
    async set(key: string, state: NodeSavedState) {
      await db
        .insert(schema.oauthAuthRequest)
        .values({ key, state })
        .onConflictDoUpdate({
          target: schema.oauthAuthRequest.key,
          set: { state },
        })
    },
    async get(key: string) {
      const row = (await db
        .select()
        .from(schema.oauthAuthRequest)
        .where(eq(schema.oauthAuthRequest.key, key))).at(0)
      return row?.state as NodeSavedState | undefined
    },
    async del(key: string) {
      await db
        .delete(schema.oauthAuthRequest)
        .where(eq(schema.oauthAuthRequest.key, key))
    },
  },

  sessionStore: {
    async set(did: string, session: NodeSavedSession) {
      await db
        .insert(schema.oauthSession)
        .values({ did, session })
        .onConflictDoUpdate({
          target: schema.oauthSession.did,
          set: { session, updatedAt: new Date() },
        })
    },
    async get(did: string) {
      const row = (await db
        .select()
        .from(schema.oauthSession)
        .where(eq(schema.oauthSession.did, did))).at(0)
      return row?.session as NodeSavedSession | undefined
    },
    async del(did: string) {
      await db.delete(schema.oauthSession).where(eq(schema.oauthSession.did, did))
    },
  },
})
