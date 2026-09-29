import { and, desc, eq, exists, inArray, isNull, or, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { schema } from "@workspace/db"
import { db } from "../db.ts"
import { cursor, hydratePosts, loadPosts } from "./hydrate.ts"
import type { PostRow } from "./hydrate.ts"

/** An active actor by DID or handle, or undefined. */
export async function resolveActor(actorId: string) {
  const identifier = actorId.toLowerCase()
  const [actor] = await db
    .select({ did: schema.actor.did, active: schema.actor.active })
    .from(schema.actor)
    .where(
      identifier.startsWith("did:")
        ? eq(schema.actor.did, actorId)
        : eq(schema.actor.handle, identifier)
    )
  return actor?.active ? actor.did : undefined
}

/** A newest-first page of posts matching `where`. */
async function page(where: SQL | undefined, limit: number, after?: string) {
  const c = cursor.decode(after)
  const rows = await db
    .select({ post: schema.post, active: schema.actor.active })
    .from(schema.post)
    .innerJoin(schema.actor, eq(schema.actor.did, schema.post.did))
    .where(
      and(
        where,
        eq(schema.actor.active, true),
        c ? cursor.before(schema.post, c) : undefined
      )
    )
    .orderBy(desc(schema.post.sortAt), desc(schema.post.uri))
    .limit(limit)
  const posts: Array<PostRow> = rows.map((r) => ({
    ...r.post,
    active: r.active,
  }))
  const last = posts.at(-1)
  return {
    posts,
    cursor: posts.length === limit && last ? cursor.encode(last) : undefined,
  }
}

/**
 * Feed items for a page of posts, with reply context, in the order given.
 * Posts hidden in the community they are shown in are left out of every
 * list, the author's own included; they stay in the author's repo. Posts by
 * inactive authors are left out. Phase 8's getFeed hydrates skeletons with
 * this too, so a feed generator gets exactly the same policy.
 */
export async function feedItems(
  posts: Array<PostRow>,
  viewer: string | undefined
) {
  const context = await loadPosts(
    posts.flatMap((p) =>
      p.replyRootUri ? [p.replyRootUri, p.replyParentUri!] : []
    )
  )
  const h = await hydratePosts([...context.values(), ...posts], viewer)
  return posts.flatMap((p) => {
    if (h.isHidden(p)) return []
    const post = h.view(p.uri)
    if (!post) return []
    return [
      {
        post,
        ...(p.replyRootUri
          ? {
              reply: {
                root: h.item(p.replyRootUri),
                parent: h.item(p.replyParentUri!),
              },
            }
          : {}),
      },
    ]
  })
}

/** sh.authentiq.feed.getAuthorFeed: posts and replies, newest first. */
export async function getAuthorFeed(opts: {
  did: string
  limit: number
  cursor?: string
  viewer: string | undefined
}) {
  const { posts, cursor: next } = await page(
    eq(schema.post.did, opts.did),
    opts.limit,
    opts.cursor
  )
  return { cursor: next, feed: await feedItems(posts, opts.viewer) }
}

/** A community whose creator is active, or undefined. */
export async function loadCommunity(uri: string) {
  const [row] = await db
    .select({ community: schema.community })
    .from(schema.community)
    .innerJoin(schema.actor, eq(schema.actor.did, schema.community.did))
    .where(and(eq(schema.community.uri, uri), eq(schema.actor.active, true)))
  return row?.community
}

/**
 * sh.authentiq.community.getPosts: top-level posts written into the
 * community by its current members (the creator counts as one), minus the
 * ones the creator hid. Membership is checked now, not when the post was
 * indexed: a post that arrives before its author's membership appears once
 * the membership does, and leaving takes an author's posts out.
 */
export async function getCommunityPosts(opts: {
  community: { uri: string; did: string }
  limit: number
  cursor?: string
  viewer: string | undefined
}) {
  const { uri, did: creator } = opts.community
  const { posts, cursor: next } = await page(
    and(
      eq(schema.post.communityUri, uri),
      isNull(schema.post.replyRootUri),
      or(
        eq(schema.post.did, creator),
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.membership)
            .where(
              and(
                eq(schema.membership.did, schema.post.did),
                eq(schema.membership.communityUri, uri)
              )
            )
        )
      ),
      sql`not exists (select 1 from ${schema.communityHiddenPost} h where h.community_uri = ${uri} and h.post_uri = ${schema.post.uri})`
    ),
    opts.limit,
    opts.cursor
  )
  return { cursor: next, feed: await feedItems(posts, opts.viewer) }
}

/**
 * sh.authentiq.feed.getTimeline (phase 8): posts and replies by the accounts
 * the viewer follows, newest first. Served here rather than by a feed
 * generator, so the home page works whatever state the generators are in.
 * It is the same definition as the first-party `following` feed. Follows of
 * inactive accounts count for nothing, as everywhere else.
 */
export async function getTimeline(opts: {
  viewer: string
  limit: number
  cursor?: string
}) {
  const { posts, cursor: next } = await page(
    inArray(
      schema.post.did,
      db
        .select({ subject: schema.follow.subject })
        .from(schema.follow)
        .where(eq(schema.follow.did, opts.viewer))
    ),
    opts.limit,
    opts.cursor
  )
  return { cursor: next, feed: await feedItems(posts, opts.viewer) }
}
