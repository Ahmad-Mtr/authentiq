import { randomBytes } from "node:crypto"
import { Agent } from "@atproto/api"
import { and, eq, gt } from "drizzle-orm"
import {
  deleteCookie,
  getCookie,
  setCookie,
} from "@tanstack/react-start/server"
import { db, schema } from "./db.ts"
import { oauthClient } from "./oauth.ts"

const COOKIE = "authentiq_session"
const TTL_DAYS = 30

/** Issues a browser session for a DID and sets the cookie. */
export async function createWebSession(did: string) {
  const id = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000)
  await db.insert(schema.webSession).values({ id, did, expiresAt })
  setCookie(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Dev runs on http://127.0.0.1; a deployment would set secure: true.
    secure: false,
    expires: expiresAt,
  })
  return id
}

/** The signed-in user's DID, or undefined. */
export async function getSessionDid(): Promise<string | undefined> {
  const id = getCookie(COOKIE)
  if (!id) return undefined
  const row = (await db
    .select()
    .from(schema.webSession)
    .where(
      and(eq(schema.webSession.id, id), gt(schema.webSession.expiresAt, new Date()))
    )).at(0)
  return row?.did
}

export async function destroyWebSession() {
  const id = getCookie(COOKIE)
  if (id) await db.delete(schema.webSession).where(eq(schema.webSession.id, id))
  deleteCookie(COOKIE, { path: "/" })
}

/**
 * An `@atproto/api` Agent bound to the user's OAuth session, for writing to
 * their repo. Token refresh and DPoP are handled by the OAuth client.
 */
export async function getAgent(did: string) {
  const session = await oauthClient.restore(did)
  return new Agent(session)
}

/** Agent for the signed-in user, or undefined when signed out. */
export async function getSessionAgent() {
  const did = await getSessionDid()
  if (!did) return undefined
  try {
    return await getAgent(did)
  } catch {
    // Session revoked or expired past refresh; treat as signed out.
    return undefined
  }
}
