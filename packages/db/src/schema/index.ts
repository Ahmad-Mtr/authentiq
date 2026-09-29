import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

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

// --- AppView index ------------------------------------------------------------
//
// Everything below is derived from users' repos by the firehose indexer
// (apps/appview/src/indexer). It is disposable: dropping these tables and
// re-running backfill rebuilds them.

/**
 * Every account the indexer has seen, from the firehose or from backfill.
 * `handle` is null when the DID document's handle does not verify.
 * `active` is false after a deactivation, suspension or takedown: the rows
 * stay, but queries hide the actor until an `#account` event reactivates it.
 */
export const actor = pgTable(
  "actor",
  {
    did: text().primaryKey(),
    handle: text(),
    active: boolean().notNull().default(true),
    status: text(),
    /** Latest repo revision applied to the index; older commits are skipped. */
    rev: text(),
    /** Set once the whole repo has been fetched with `com.atproto.sync.getRepo`. */
    backfilledAt: timestamp({ withTimezone: true }),
    indexedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("actor_handle_idx").on(t.handle)]
)

/** Columns shared by every indexed record table. */
const recordColumns = () => ({
  uri: text().primaryKey(),
  cid: text().notNull(),
  did: text()
    .notNull()
    .references(() => actor.did, { onDelete: "cascade" }),
  indexedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/** `sh.authentiq.actor.profile`, one per actor (rkey `self`). */
export const profile = pgTable(
  "profile",
  {
    ...recordColumns(),
    displayName: text().notNull(),
    headline: text(),
    about: text(),
    avatarCid: text(),
    location: text(),
    openToWork: boolean(),
    skills: text().array(),
    createdAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("profile_did_idx").on(t.did)]
)

/** `sh.authentiq.actor.position`. Dates are `YYYY` or `YYYY-MM`, checked at index time. */
export const position = pgTable(
  "position",
  {
    ...recordColumns(),
    title: text().notNull(),
    organization: text().notNull(),
    employmentType: text(),
    locationType: text(),
    location: text(),
    startDate: text().notNull(),
    endDate: text(),
    description: text(),
    skills: text().array(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("position_did_idx").on(t.did)]
)

/** `sh.authentiq.actor.education`. */
export const education = pgTable(
  "education",
  {
    ...recordColumns(),
    school: text().notNull(),
    degree: text(),
    fieldOfStudy: text(),
    startDate: text(),
    endDate: text(),
    description: text(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("education_did_idx").on(t.did)]
)
