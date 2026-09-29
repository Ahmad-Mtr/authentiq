import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { schema } from "@workspace/db"
import { MATCH_BANDS } from "@workspace/rules/match"
import { db } from "./db.ts"

/**
 * The first-party feeds (phase 8). Each returns a skeleton: references, in
 * order, and an opaque cursor. It never returns scores or views, and it is
 * not the last word: the AppView hydrates what it can and applies its own
 * policy (hides, deactivation, closed postings, the non-member rule). The
 * queries pre-filter what they cheaply can (active authors, open postings,
 * current members), so pages come back close to full.
 *
 * Data comes from the AppView's index through the read-only `feedgen_reader`
 * role. See the phase 8 doc for why, and what that couples.
 *
 * | feed             | anonymous                           | order                         |
 * | ---------------- | ----------------------------------- | ----------------------------- |
 * | following        | AuthRequired                        | newest first                  |
 * | my-communities   | AuthRequired                        | newest first                  |
 * | jobs-for-you     | AuthRequired                        | closest match first, no score |
 * | industry-pulse   | recent community posts, for anyone  | newest first                  |
 *
 * Nothing is ranked by likes, replies or any other activity, and nothing is
 * counted.
 */

export type SkeletonItem =
  | { $type: "sh.authentiq.feed.defs#skeletonPost"; post: string }
  | { $type: "sh.authentiq.feed.defs#skeletonJob"; job: string }

export type AlgoResult = { feed: Array<SkeletonItem>; cursor?: string }

export class AlgoError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string
  ) {
    super(message)
  }
}

type Ctx = { viewer: string | undefined; limit: number; cursor?: string }
type Algo = (ctx: Ctx) => Promise<AlgoResult>

const post = (uri: string): SkeletonItem => ({
  $type: "sh.authentiq.feed.defs#skeletonPost",
  post: uri,
})
const job = (uri: string): SkeletonItem => ({
  $type: "sh.authentiq.feed.defs#skeletonJob",
  job: uri,
})

const requireViewer = (ctx: Ctx, feed: string) => {
  if (!ctx.viewer) {
    throw new AlgoError(401, "AuthRequired", `Sign in to see ${feed}`)
  }
  return ctx.viewer
}

// --- cursors ------------------------------------------------------------------

/** `sortAt::uri` keyset cursors, for newest-first feeds. */
export const keyset = {
  encode: (row: { sortAt: Date; uri: string }) =>
    `${row.sortAt.getTime()}::${row.uri}`,
  decode(value: string | undefined) {
    if (!value) return undefined
    const i = value.indexOf("::")
    const ms = Number(value.slice(0, i))
    if (i < 0 || !Number.isFinite(ms) || !value.slice(i + 2).startsWith("at://")) {
      throw new AlgoError(400, "InvalidRequest", "Malformed cursor")
    }
    return { sortAt: new Date(ms), uri: value.slice(i + 2) }
  },
}

/**
 * Offset cursors, for ranked feeds. A keyset cursor there would have to carry
 * the similarity, which is a score in all but name.
 */
export const offset = {
  encode: (n: number) => `o:${n}`,
  decode(value: string | undefined) {
    if (!value) return 0
    const n = Number(value.match(/^o:(\d{1,4})$/)?.[1] ?? Number.NaN)
    if (!Number.isSafeInteger(n)) {
      throw new AlgoError(400, "InvalidRequest", "Malformed cursor")
    }
    return n
  },
}

// --- shared queries -------------------------------------------------------------

const p = schema.post

/** A newest-first page of posts by active authors matching `where`. */
async function postPage(where: SQL | undefined, ctx: Ctx): Promise<AlgoResult> {
  const after = keyset.decode(ctx.cursor)
  const rows = await db
    .select({ uri: p.uri, sortAt: p.sortAt })
    .from(p)
    .innerJoin(schema.actor, eq(schema.actor.did, p.did))
    .where(
      and(
        where,
        eq(schema.actor.active, true),
        after
          ? sql`(${p.sortAt}, ${p.uri}) < (${after.sortAt.toISOString()}::timestamptz, ${after.uri})`
          : undefined
      )
    )
    .orderBy(desc(p.sortAt), desc(p.uri))
    .limit(ctx.limit)
  const last = rows.at(-1)
  return {
    feed: rows.map((r) => post(r.uri)),
    cursor: rows.length === ctx.limit && last ? keyset.encode(last) : undefined,
  }
}

/** The viewer's own profile embedding, if they have one yet. */
async function profileVector(did: string) {
  const [row] = await db
    .select({ vector: schema.embedding.vector })
    .from(schema.embedding)
    .where(
      and(
        eq(schema.embedding.subject, did),
        eq(schema.embedding.kind, "actor"),
        sql`${schema.embedding.vector} is not null`
      )
    )
  return row?.vector ?? undefined
}

const vectorLiteral = (v: Array<number>) => `[${v.join(",")}]`

// --- the feeds ------------------------------------------------------------------

/** Posts and replies by the accounts the viewer follows, newest first. */
const following: Algo = async (ctx) => {
  const viewer = requireViewer(ctx, "who you follow")
  return postPage(
    inArray(
      p.did,
      db
        .select({ subject: schema.follow.subject })
        .from(schema.follow)
        .where(eq(schema.follow.did, viewer))
    ),
    ctx
  )
}

/**
 * Threads started in the communities the viewer belongs to (or created), by
 * people who are members now: the community page's rule, across all of
 * them. One feed rather than a generator record per community; see the
 * phase 8 doc.
 */
const myCommunities: Algo = async (ctx) => {
  const viewer = requireViewer(ctx, "your communities")
  const mine = sql`(
    select ${schema.community.uri} from ${schema.community} where ${schema.community.did} = ${viewer}
    union
    select ${schema.membership.communityUri} from ${schema.membership} where ${schema.membership.did} = ${viewer}
  )`
  return postPage(
    and(
      sql`${p.communityUri} in ${mine}`,
      isNull(p.replyRootUri),
      or(
        sql`${p.did} = (select c.did from ${schema.community} c where c.uri = ${p.communityUri})`,
        sql`exists (select 1 from ${schema.membership} m where m.did = ${p.did} and m.community_uri = ${p.communityUri})`
      )
    ),
    ctx
  )
}

/** At most this many postings are ever suggested: it is "for you", not the board. */
const JOBS_MAX = 100

/**
 * Open postings whose document is close to the viewer's profile document,
 * closest first: phase 7's match score, applied to the whole board. Only
 * postings the viewer would see labelled "partial" or "strong" are kept
 * (`MATCH_BANDS`, shared with the AppView). No similarity leaves this
 * function: the skeleton is URIs in order, and the cursor is an offset.
 * The viewer's own postings are left out. A viewer with no profile, or one
 * not embedded yet, gets an empty feed.
 */
const jobsForYou: Algo = async (ctx) => {
  const viewer = requireViewer(ctx, "jobs for you")
  const vector = await profileVector(viewer)
  const skip = offset.decode(ctx.cursor)
  if (!vector || skip >= JOBS_MAX) return { feed: [] }
  const j = schema.jobPosting
  const e = schema.embedding
  const me = sql`${vectorLiteral(vector)}::vector`
  const take = Math.min(ctx.limit, JOBS_MAX - skip)
  const rows = await db
    .select({ uri: j.uri })
    .from(j)
    .innerJoin(schema.actor, eq(schema.actor.did, j.did))
    .innerJoin(e, eq(e.subject, j.uri))
    .where(
      and(
        eq(schema.actor.active, true),
        or(isNull(j.closesAt), gt(j.closesAt, sql`now()`)),
        sql`${j.did} <> ${viewer}`,
        sql`${e.vector} is not null`,
        sql`1 - (${e.vector} <=> ${me}) >= ${MATCH_BANDS.partial}`
      )
    )
    .orderBy(sql`${e.vector} <=> ${me}`, j.uri)
    .offset(skip)
    .limit(take)
  return {
    feed: rows.map((r) => job(r.uri)),
    cursor:
      rows.length === take && skip + take < JOBS_MAX
        ? offset.encode(skip + take)
        : undefined,
  }
}

/** How many nearest profiles make up someone's "industry". */
const PULSE_NEIGHBOURS = 25
const PULSE_WINDOW = sql`now() - interval '90 days'`

/**
 * What people in your line of work are writing. Signed in, with a profile:
 * top-level posts from the last 90 days by the 25 accounts whose profile
 * documents are nearest yours, newest first. Anonymous, or with no profile
 * yet: top-level community posts from the last 90 days, newest first, the
 * same for everyone.
 *
 * Ordered by time, not activity. Nothing is ranked by likes or replies, and
 * there is no "trending": phase 6's rule against engagement presented as
 * popularity applies to feeds too.
 */
const industryPulse: Algo = async (ctx) => {
  const vector = ctx.viewer ? await profileVector(ctx.viewer) : undefined
  const recentTopLevel = and(isNull(p.replyRootUri), sql`${p.sortAt} > ${PULSE_WINDOW}`)
  if (!ctx.viewer || !vector) {
    return postPage(and(recentTopLevel, sql`${p.communityUri} is not null`), ctx)
  }
  const e = schema.embedding
  const near = db
    .select({ did: e.did })
    .from(e)
    .innerJoin(schema.actor, eq(schema.actor.did, e.did))
    .where(
      and(
        eq(e.kind, "actor"),
        eq(schema.actor.active, true),
        sql`${e.vector} is not null`,
        sql`${e.did} <> ${ctx.viewer}`
      )
    )
    .orderBy(sql`${e.vector} <=> ${sql`${vectorLiteral(vector)}::vector`}`)
    .limit(PULSE_NEIGHBOURS)
  return postPage(and(recentTopLevel, inArray(p.did, near)), ctx)
}

/** By record key: the feed URI is at://<publisher>/sh.authentiq.feed.generator/<key>. */
export const ALGOS: Record<string, Algo> = {
  following,
  "my-communities": myCommunities,
  "jobs-for-you": jobsForYou,
  "industry-pulse": industryPulse,
}
