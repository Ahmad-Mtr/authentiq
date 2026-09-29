import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { db } from "../db.ts"
import { loadCommunity } from "./feeds.ts"
import { cursor, hydratePosts, loadPosts, loadProfileViews } from "./hydrate.ts"

type CommunityRow = typeof schema.community.$inferSelect

/** Community views, with the viewer's membership. No member counts. */
async function communityViews(
  rows: Array<CommunityRow>,
  viewer: string | undefined
) {
  const [creators, memberships] = await Promise.all([
    loadProfileViews(rows.map((r) => r.did)),
    viewer && rows.length > 0
      ? db
          .select({
            uri: schema.membership.uri,
            community: schema.membership.communityUri,
          })
          .from(schema.membership)
          .where(
            and(
              eq(schema.membership.did, viewer),
              inArray(
                schema.membership.communityUri,
                rows.map((r) => r.uri)
              )
            )
          )
      : [],
  ])
  const joined = new Map(memberships.map((m) => [m.community, m.uri]))
  return rows.flatMap((r) => {
    const creator = creators.get(r.did)
    if (!creator) return []
    return [
      sh.authentiq.community.defs.communityView.parse({
        uri: r.uri,
        cid: r.cid,
        creator,
        name: r.name,
        description: r.description ?? undefined,
        topic: r.topic,
        rules: r.rules ?? undefined,
        createdAt: r.createdAt.toISOString(),
        indexedAt: r.indexedAt.toISOString(),
        viewer: viewer
          ? { membership: joined.get(r.uri), isCreator: viewer === r.did }
          : undefined,
      }),
    ]
  })
}

/** sh.authentiq.community.list: newest first, optionally one topic. */
export async function listCommunities(opts: {
  topic?: string
  limit: number
  cursor?: string
  viewer: string | undefined
}) {
  const c = cursor.decode(opts.cursor)
  const rows = await db
    .select({ community: schema.community })
    .from(schema.community)
    .innerJoin(schema.actor, eq(schema.actor.did, schema.community.did))
    .where(
      and(
        eq(schema.actor.active, true),
        opts.topic
          ? sql`lower(${schema.community.topic}) = lower(${opts.topic})`
          : undefined,
        c ? cursor.before(schema.community, c) : undefined
      )
    )
    .orderBy(desc(schema.community.sortAt), desc(schema.community.uri))
    .limit(opts.limit)
  const list = rows.map((r) => r.community)
  const last = list.at(-1)
  return {
    cursor:
      list.length === opts.limit && last ? cursor.encode(last) : undefined,
    communities: await communityViews(list, opts.viewer),
  }
}

export async function getCommunity(uri: string, viewer: string | undefined) {
  const row = await loadCommunity(uri)
  if (!row) return undefined
  return (await communityViews([row], viewer))[0]
}

export type HideResult =
  | { ok: true; hidden: boolean }
  | { status: 400 | 403; error: string; message: string }

/**
 * sh.authentiq.community.hidePost / unhidePost. Only the declaration's author
 * may call them. Hiding needs the post to be shown in this community right
 * now (the same rule views apply), so the label cannot reach outside it.
 * Unhiding needs only the ownership check, so a label on a post that has
 * since gone can still be cleared.
 */
export async function setHidden(opts: {
  caller: string
  community: string
  post: string
  hidden: boolean
}): Promise<HideResult> {
  const community = await loadCommunity(opts.community)
  if (!community) {
    return {
      status: 400,
      error: "CommunityNotFound",
      message: `Unknown community: ${opts.community}`,
    }
  }
  if (community.did !== opts.caller) {
    return {
      status: 403,
      error: "NotCommunityCreator",
      message: "Only the community's creator can hide or unhide its posts",
    }
  }
  if (!opts.hidden) {
    await db
      .delete(schema.communityHiddenPost)
      .where(
        and(
          eq(schema.communityHiddenPost.communityUri, community.uri),
          eq(schema.communityHiddenPost.postUri, opts.post)
        )
      )
    console.log(
      `[community] ${opts.caller} unhid ${opts.post} in ${community.uri}`
    )
    return { ok: true, hidden: false }
  }
  const post = (await loadPosts([opts.post])).get(opts.post)
  if (!post?.active) {
    return {
      status: 400,
      error: "PostNotFound",
      message: `Unknown post: ${opts.post}`,
    }
  }
  const h = await hydratePosts([post], undefined)
  if (h.communityOf(post)?.uri !== community.uri) {
    return {
      status: 400,
      error: "NotInCommunity",
      message: "That post is not shown in this community",
    }
  }
  await db
    .insert(schema.communityHiddenPost)
    .values({
      communityUri: community.uri,
      postUri: post.uri,
      hiddenBy: opts.caller,
    })
    .onConflictDoNothing()
  // Identifiers only; never post content.
  console.log(`[community] ${opts.caller} hid ${post.uri} in ${community.uri}`)
  return { ok: true, hidden: true }
}
