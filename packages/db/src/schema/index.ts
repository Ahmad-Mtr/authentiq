import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

/**
 * Small key/value store for service bookkeeping, e.g. the AppView's firehose
 * cursor (`firehose:cursor`) so indexing resumes where it left off.
 */
export const serviceState = pgTable("service_state", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/**
 * In-flight ATProto OAuth authorization requests (PKCE verifier, DPoP key).
 * Written when the user is sent to their PDS, read once on callback.
 * Backs `NodeOAuthClient`'s `stateStore`.
 */
export const oauthAuthRequest = pgTable("oauth_auth_request", {
  key: text().primaryKey(),
  state: jsonb().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/**
 * Authenticated ATProto sessions, keyed by the user's DID ("sub").
 * Holds refresh + access tokens and the DPoP key, so it never reaches the
 * browser. Backs `NodeOAuthClient`'s `sessionStore`.
 */
export const oauthSession = pgTable("oauth_session", {
  did: text().primaryKey(),
  session: jsonb().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/**
 * Browser sessions. The cookie carries only this opaque id; the DID lookup
 * happens server-side.
 */
export const webSession = pgTable(
  "web_session",
  {
    id: text().primaryKey(),
    did: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("web_session_did_idx").on(t.did)]
)
