import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm"
import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { db } from "../db.ts"
import { toJobViews } from "../jobs/board.ts"
import { feedItems } from "../social/feeds.ts"
import { loadPosts } from "../social/hydrate.ts"
import type { SkeletonItem } from "./skeleton.ts"

/**
 * Hydrates a clamped skeleton under the AppView's own policy, which a feed
 * generator cannot opt out of. Posts go through the same `feedItems` as
 * author feeds and community pages; postings through the same `toJobViews`
 * as the board. So an item is silently left out when:
 *
 * - it is not in the index: deleted, never valid (a salary-less posting, an
 *   over-length post), or not indexed yet;
 * - its author is deactivated, suspended or taken down;
 * - it is a post the creator of the community it is shown in hid;
 * - it is a job posting that has closed (the board's rule).
 *
 * A post that names a community its author is not a member of is shown, as
 * on the author's profile, without the community: it cannot claim it in a
 * feed any more than on the community page. Missing items are dropped, not
 * shown as errors, and the order of the rest is the generator's.
 */

const FEED_VIEW_POST = `${sh.authentiq.feed.defs.$nsid}#feedViewPost` as const
const JOB_VIEW = `${sh.authentiq.job.defs.$nsid}#jobView` as const

/** Open postings by active authors, by URI. */
async function loadOpenPostings(uris: Array<string>) {
  if (uris.length === 0) return []
  const j = schema.jobPosting
  const rows = await db
    .select({ job: j })
    .from(j)
    .innerJoin(schema.actor, eq(schema.actor.did, j.did))
    .where(
      and(
        inArray(j.uri, uris),
        eq(schema.actor.active, true),
        or(isNull(j.closesAt), gt(j.closesAt, sql`now()`))
      )
    )
  return rows.map((r) => r.job)
}

export async function hydrateSkeleton(
  items: Array<SkeletonItem>,
  viewer: string | undefined
) {
  const postUris = items.filter((i) => i.kind === "post").map((i) => i.uri)
  const jobUris = items.filter((i) => i.kind === "job").map((i) => i.uri)
  const [posts, jobs] = await Promise.all([
    loadPosts(postUris),
    loadOpenPostings(jobUris),
  ])

  const postRows = postUris.flatMap((u) => {
    const row = posts.get(u)
    return row ? [row] : []
  })
  const views = new Map<string, Record<string, unknown>>()
  for (const item of await feedItems(postRows, viewer)) {
    views.set(item.post.uri, { $type: FEED_VIEW_POST, ...item })
  }
  for (const job of await toJobViews(jobs, viewer)) {
    views.set(job.uri, { $type: JOB_VIEW, ...job })
  }

  const feed = items.flatMap((i) => {
    const view = views.get(i.uri)
    return view ? [view] : []
  })
  return { feed, withheld: items.length - feed.length }
}
