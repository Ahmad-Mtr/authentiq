import { sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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

/**
 * Posts a community's creator hid (phase 6): a moderation label, not a repo
 * record, so a replay does not rebuild it. It only applies while the post is
 * shown in `communityUri` (checked when views are built), so a creator cannot
 * hide anything outside their own community. The post stays in its author's
 * repo.
 */
export const communityHiddenPost = pgTable(
  "community_hidden_post",
  {
    communityUri: text().notNull(),
    postUri: text().notNull(),
    /** The creator's DID at the time; the community URI already names them. */
    hiddenBy: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.communityUri, t.postUri] }),
    index("community_hidden_post_post_idx").on(t.postUri),
  ]
)

/**
 * A signed-in account's pinned feeds, in order (phase 8). Private AppView
 * state behind service auth, deliberately not a repo record: which feeds
 * someone reads (jobs-for-you, say) would otherwise be public. The price is
 * that pins are not portable and a rebuild from repos does not restore them.
 */
export const feedPin = pgTable("feed_pin", {
  /** Goes with the account: deleting it (or its index row) removes its pins. */
  did: text()
    .primaryKey()
    .references(() => actor.did, { onDelete: "cascade" }),
  /** Generator record AT-URIs, in the order the user pinned them. */
  feeds: text().array().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

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
 * `sh.authentiq.feed.post` (phase 6). Reply and community references are
 * stored as the URIs and CIDs the record names, and never checked against
 * other rows when indexed: events arrive out of order across repos, so a
 * reply can be indexed before its parent. Threads, communities and
 * visibility are resolved when a view is built (apps/appview/src/social).
 */
export const post = pgTable(
  "post",
  {
    ...recordColumns(),
    text: text().notNull(),
    facets: jsonb(),
    replyRootUri: text(),
    replyRootCid: text(),
    replyParentUri: text(),
    replyParentCid: text(),
    communityUri: text(),
    communityCid: text(),
    embed: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    /**
     * Feed order: the earlier of createdAt and the time it was first indexed,
     * so a future-dated createdAt cannot pin a post to the top.
     */
    sortAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    index("post_did_sort_idx").on(t.did, t.sortAt.desc(), t.uri.desc()),
    index("post_reply_root_idx").on(t.replyRootUri),
    index("post_reply_parent_idx").on(t.replyParentUri),
    index("post_community_sort_idx")
      .on(t.communityUri, t.sortAt.desc(), t.uri.desc())
      .where(sql`${t.communityUri} is not null and ${t.replyRootUri} is null`),
  ]
)

/** `sh.authentiq.feed.like`. Only ever read as viewer state; never counted. */
export const postLike = pgTable(
  "post_like",
  {
    ...recordColumns(),
    subjectUri: text().notNull(),
    subjectCid: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("post_like_did_subject_idx").on(t.did, t.subjectUri)]
)

/** `sh.authentiq.graph.follow`. Only ever read as viewer state; never counted. */
export const follow = pgTable(
  "follow",
  {
    ...recordColumns(),
    subject: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    index("follow_did_subject_idx").on(t.did, t.subject),
    index("follow_subject_idx").on(t.subject),
  ]
)

/** `sh.authentiq.community.declaration`. `did` is the creator. */
export const community = pgTable(
  "community",
  {
    ...recordColumns(),
    name: text().notNull(),
    description: text(),
    topic: text().notNull(),
    rules: text().array(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    sortAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    index("community_did_idx").on(t.did),
    index("community_sort_idx").on(t.sortAt.desc(), t.uri.desc()),
  ]
)

/** `sh.authentiq.community.membership`, in the member's repo. */
export const membership = pgTable(
  "membership",
  {
    ...recordColumns(),
    communityUri: text().notNull(),
    communityCid: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    index("membership_community_did_idx").on(t.communityUri, t.did),
    index("membership_did_idx").on(t.did),
  ]
)

/**
 * `sh.authentiq.job.posting` (phase 7). Only postings that pass the salary
 * transparency rules (@workspace/rules) are here; a record that breaks them
 * stays in its author's repo and is never indexed. Amounts are whole units
 * of `salaryCurrency`. `annualMin`/`annualMax` are the same range per year
 * (2080 hours, 260 days, 52 weeks, 12 months), for the salary floor and the
 * salary sort, which only ever compare within one currency. Postings are
 * editable, so every update replaces the row.
 */
export const jobPosting = pgTable(
  "job_posting",
  {
    ...recordColumns(),
    title: text().notNull(),
    organization: text().notNull(),
    description: text(),
    location: text(),
    locationType: text(),
    employmentType: text(),
    skills: text().array(),
    salaryMin: bigint({ mode: "number" }).notNull(),
    salaryMax: bigint({ mode: "number" }).notNull(),
    salaryCurrency: text().notNull(),
    salaryPeriod: text().notNull(),
    annualMin: bigint({ mode: "number" }).notNull(),
    annualMax: bigint({ mode: "number" }).notNull(),
    applyUrl: text(),
    /** `YYYY-MM-DD` as written. */
    closeDate: text(),
    /** When the close date has ended everywhere on Earth; null = no close date. */
    closesAt: timestamp({ withTimezone: true }),
    /** Title, organization, description and skills, for the board's `q`. */
    searchText: text().notNull(),
    search: tsvector().generatedAlwaysAs(
      (): SQL => sql`to_tsvector('english', ${jobPosting.searchText})`
    ),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    /** Board order: the earlier of createdAt and first indexing, as for posts. */
    sortAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    index("job_posting_did_idx").on(t.did),
    index("job_posting_sort_idx").on(t.sortAt.desc(), t.uri.desc()),
    index("job_posting_salary_idx").on(
      t.salaryCurrency,
      t.annualMin.desc(),
      t.annualMax.desc(),
      t.uri.desc()
    ),
    index("job_posting_search_idx").using("gin", t.search),
  ]
)

/**
 * `sh.authentiq.feed.generator` (phase 8): a feed declaration in its
 * publisher's repo. `serviceDid` is the record's `did`, the feed generator
 * service; it is resolved to an endpoint only when the feed is read, through
 * the fetch guard (apps/appview/src/feeds/resolve.ts).
 */
export const feedGenerator = pgTable(
  "feed_generator",
  {
    ...recordColumns(),
    serviceDid: text().notNull(),
    displayName: text().notNull(),
    description: text(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    /** Discovery order: the earlier of createdAt and first indexing. */
    sortAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    index("feed_generator_did_idx").on(t.did),
    index("feed_generator_sort_idx").on(t.sortAt, t.uri),
  ]
)

/**
 * Search documents and their vectors (phase 5). One row per embedded subject:
 * for `kind = "actor"` the subject is the actor's DID and the document is
 * built from their profile, positions and education. For `kind = "job"`
 * (phase 7) the subject is the posting's AT-URI and `did` its author.
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
