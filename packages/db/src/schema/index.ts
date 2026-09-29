import { sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core"

/** Postgres full-text search vector; Drizzle has no built-in type for it. */
const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
})

/** Must equal `EMBEDDING_DIMENSIONS` in packages/ai (mistral-embed). */
export const EMBEDDING_COLUMN_DIMENSIONS = 1024

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

// --- AppView private state ----------------------------------------------------
//
// Not derived from repos and not public (ADR 0001). Short-lived by design.

/**
 * A parsed resume awaiting the user's review (phase 4). Holds only the
 * structured draft: the uploaded file and its extracted text are never
 * stored. Deleted on confirm or discard; expired rows are swept by the
 * AppView and are never served.
 */
export const resumeDraft = pgTable(
  "resume_draft",
  {
    id: text().primaryKey(),
    did: text().notNull(),
    draft: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    index("resume_draft_did_idx").on(t.did),
    index("resume_draft_expires_at_idx").on(t.expiresAt),
  ]
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

/**
 * Search documents and their vectors (phase 5). One row per embedded subject:
 * for `kind = "actor"` the subject is the actor's DID and the document is
 * built from their profile, positions and education. Phase 7 adds job
 * postings as another kind, keyed by record URI.
 *
 * The indexer only sets `dirtyAt`; a worker builds the document, and embeds it
 * when `contentHash` differs from `embeddedHash`. So a model outage delays
 * vectors but never blocks or loses firehose events, and FTS (over `search`)
 * is current as soon as the document is rebuilt. Rows go with the actor.
 */
export const embedding = pgTable(
  "embedding",
  {
    subject: text().primaryKey(),
    kind: text().notNull(),
    did: text()
      .notNull()
      .references(() => actor.did, { onDelete: "cascade" }),
    /** Canonical document; null until the worker first builds it. */
    document: text(),
    search: tsvector().generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', coalesce(${embedding.document}, ''))`
    ),
    /** sha256 of model, builder version and document. */
    contentHash: text(),
    /** The hash `vector` was computed from; differs from contentHash while stale. */
    embeddedHash: text(),
    model: text(),
    vector: vector({ dimensions: EMBEDDING_COLUMN_DIMENSIONS }),
    /** Model calls that produced a vector for this subject, for verification. */
    embedCount: integer().notNull().default(0),
    /** Set when the source records change; cleared once processed. */
    dirtyAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }),
    /** Error type of the last failed attempt; never content. */
    lastError: text(),
    embeddedAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("embedding_did_idx").on(t.did),
    index("embedding_vector_idx").using(
      "hnsw",
      t.vector.op("vector_cosine_ops")
    ),
    index("embedding_search_idx").using("gin", t.search),
    index("embedding_dirty_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.dirtyAt} is not null`),
  ]
)
