import { and, eq, inArray, sql } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { db } from "../db.ts"

/**
 * Turns indexed rows into views (phase 6). Every relationship is resolved
 * here, at read time, never when a record is indexed:
 *
 * - **Community.** A top-level post is shown in the community it names only
 *   if its author is currently a member (or the creator) and the community
 *   exists. A reply is shown in its root's community. Otherwise the post has
 *   no community.
 * - **Hidden.** A post is hidden if the creator of the community it is shown
 *   in hid it. A label for any other community has no effect.
 * - **Deactivated accounts.** Posts by an inactive actor are not found;
 *   likes, follows and memberships only count for active actors.
 * - **Reply counts.** Direct replies by active authors that belong to the
 *   same thread and are not hidden. Navigation, not a score.
 *
 * Views carry the viewer's own state only. There is no like count, follower
 * count or member count anywhere, by design.
 */

export type PostRow = typeof schema.post.$inferSelect & { active: boolean }
type ProfileView = sh.authentiq.actor.defs.ProfileView
type PostView = sh.authentiq.feed.defs.PostView

const FEED = "sh.authentiq.feed.defs"

/** Placeholders and posts as union members of the feed defs. */
export type ThreadItem =
  | ({ $type: `${typeof FEED}#threadViewPost` } & Record<string, unknown>)
  | {
      $type: `${typeof FEED}#notFoundPost`
      uri: string
      notFound: true
      replies?: Array<ThreadItem>
    }
  | {
      $type: `${typeof FEED}#hiddenPost`
      uri: string
      hidden: true
      reason: "community-moderation"
      community?: string
      replies?: Array<ThreadItem>
    }

export const notFound = (uri: string, replies?: Array<ThreadItem>) =>
  ({
    $type: `${FEED}#notFoundPost`,
    uri,
    notFound: true,
    ...(replies?.length ? { replies } : {}),
  }) as const satisfies ThreadItem

export const hidden = (
  uri: string,
  community: string | undefined,
  replies?: Array<ThreadItem>
) =>
  ({
    $type: `${FEED}#hiddenPost`,
    uri,
    hidden: true,
    reason: "community-moderation",
    community,
    ...(replies?.length ? { replies } : {}),
  }) as const satisfies ThreadItem

/** Posts by URI, with their author's active flag. Missing URIs are absent. */
export async function loadPosts(uris: Iterable<string>) {
  const list = [...new Set(uris)]
  if (list.length === 0) return new Map<string, PostRow>()
  const rows = await db
    .select({ post: schema.post, active: schema.actor.active })
    .from(schema.post)
    .innerJoin(schema.actor, eq(schema.actor.did, schema.post.did))
    .where(inArray(schema.post.uri, list))
  return new Map(rows.map((r) => [r.post.uri, { ...r.post, active: r.active }]))
}

/** Profile views for actors, profile or not. Inactive actors are left out. */
export async function loadProfileViews(dids: Iterable<string>) {
  const list = [...new Set(dids)]
  if (list.length === 0) return new Map<string, ProfileView>()
  const rows = await db
    .select({ actor: schema.actor, profile: schema.profile })
    .from(schema.actor)
    .leftJoin(schema.profile, eq(schema.profile.did, schema.actor.did))
    .where(and(inArray(schema.actor.did, list), eq(schema.actor.active, true)))
  return new Map(
    rows.map(({ actor, profile }) => [
      actor.did,
      sh.authentiq.actor.defs.profileView.parse({
        did: actor.did,
        handle: actor.handle ?? "handle.invalid",
        displayName: profile?.displayName,
        headline: profile?.headline ?? undefined,
        indexedAt: (profile?.indexedAt ?? actor.indexedAt).toISOString(),
      }),
    ])
  )
}

/**
 * Hydrates a set of posts for one viewer. `rows` may include posts by
 * inactive authors; they come back as not found.
 */
export async function hydratePosts(
  rows: Iterable<PostRow>,
  viewer: string | undefined
) {
  const posts = new Map([...rows].map((r) => [r.uri, r]))

  // Roots of replies, to know which community a reply is shown in.
  const missingRoots = [...posts.values()].flatMap((p) =>
    p.replyRootUri && !posts.has(p.replyRootUri) ? [p.replyRootUri] : []
  )
  const roots = new Map([...posts, ...(await loadPosts(missingRoots))])

  // Which community each top-level post (in `roots`) is shown in.
  const claims = [...roots.values()].filter(
    (p) => p.communityUri && !p.replyRootUri && p.active
  )
  const communityUris = [...new Set(claims.map((p) => p.communityUri!))]
  const communities = new Map<
    string,
    { uri: string; did: string; name: string; topic: string }
  >()
  const members = new Set<string>()
  if (communityUris.length > 0) {
    const [cRows, mRows] = await Promise.all([
      db
        .select({
          uri: schema.community.uri,
          did: schema.community.did,
          name: schema.community.name,
          topic: schema.community.topic,
        })
        .from(schema.community)
        .innerJoin(schema.actor, eq(schema.actor.did, schema.community.did))
        .where(
          and(
            inArray(schema.community.uri, communityUris),
            eq(schema.actor.active, true)
          )
        ),
      db
        .select({
          did: schema.membership.did,
          communityUri: schema.membership.communityUri,
        })
        .from(schema.membership)
        .where(
          and(
            inArray(schema.membership.communityUri, communityUris),
            inArray(schema.membership.did, [
              ...new Set(claims.map((p) => p.did)),
            ])
          )
        ),
    ])
    for (const c of cRows) communities.set(c.uri, c)
    for (const m of mRows) members.add(`${m.did} ${m.communityUri}`)
  }
  const shownIn = (top: PostRow | undefined) => {
    if (!top?.communityUri || top.replyRootUri || !top.active) return undefined
    const c = communities.get(top.communityUri)
    if (!c) return undefined
    const member =
      c.did === top.did || members.has(`${top.did} ${top.communityUri}`)
    return member ? c : undefined
  }
  /** The community a post is shown in: its own, or its thread root's. */
  const communityOf = (p: PostRow) =>
    shownIn(p.replyRootUri ? roots.get(p.replyRootUri) : p)

  // Direct replies, for reply counts. Same thread, active authors only.
  const replyRows =
    posts.size === 0
      ? []
      : await db
          .select({
            uri: schema.post.uri,
            parent: schema.post.replyParentUri,
            root: schema.post.replyRootUri,
          })
          .from(schema.post)
          .innerJoin(schema.actor, eq(schema.actor.did, schema.post.did))
          .where(
            and(
              inArray(schema.post.replyParentUri, [...posts.keys()]),
              eq(schema.actor.active, true)
            )
          )

  const labelled = await loadLabels([
    ...posts.keys(),
    ...replyRows.map((r) => r.uri),
  ])
  const isHiddenIn = (uri: string, community: { uri: string } | undefined) =>
    community !== undefined && labelled.has(`${community.uri} ${uri}`)

  const replyCounts = new Map<string, number>()
  for (const r of replyRows) {
    const parent = posts.get(r.parent!)
    if (!parent) continue
    // A reply whose root disagrees with its parent's is not in this thread.
    if (r.root !== (parent.replyRootUri ?? parent.uri)) continue
    if (isHiddenIn(r.uri, communityOf(parent))) continue
    replyCounts.set(parent.uri, (replyCounts.get(parent.uri) ?? 0) + 1)
  }

  const [authors, likes] = await Promise.all([
    loadProfileViews([...posts.values()].map((p) => p.did)),
    viewer && posts.size > 0
      ? db
          .select({
            uri: schema.postLike.uri,
            subject: schema.postLike.subjectUri,
          })
          .from(schema.postLike)
          .where(
            and(
              eq(schema.postLike.did, viewer),
              inArray(schema.postLike.subjectUri, [...posts.keys()])
            )
          )
      : [],
  ])
  const likedBy = new Map(likes.map((l) => [l.subject, l.uri]))

  const view = (p: PostRow): PostView | undefined => {
    const author = authors.get(p.did)
    if (!author) return undefined
    const community = communityOf(p)
    return {
      $type: `${FEED}#postView`,
      uri: p.uri,
      cid: p.cid,
      author,
      record: toRecord(p),
      embed: toEmbedView(p.embed),
      community: community
        ? { uri: community.uri, name: community.name, topic: community.topic }
        : undefined,
      replyCount: replyCounts.get(p.uri) ?? 0,
      indexedAt: p.indexedAt.toISOString(),
      viewer: viewer ? { like: likedBy.get(p.uri) } : undefined,
    } as PostView
  }

  return {
    posts,
    communityOf,
    /** Whether the creator of the community the post is shown in hid it. */
    isHidden: (p: PostRow) => isHiddenIn(p.uri, communityOf(p)),
    /** The post as a view, or undefined if it cannot be shown at all. */
    view: (uri: string) => {
      const p = posts.get(uri)
      return p?.active ? view(p) : undefined
    },
    /** For threads and reply context: a post, or the right placeholder. */
    item(uri: string): PostView | ThreadItem {
      const p = posts.get(uri)
      if (!p?.active) return notFound(uri)
      const community = communityOf(p)
      if (isHiddenIn(p.uri, community)) return hidden(uri, community?.uri)
      return view(p) ?? notFound(uri)
    },
  }
}

export type Hydrated = Awaited<ReturnType<typeof hydratePosts>>

/**
 * A thread node: the right placeholder for a post that cannot be shown (it
 * keeps its replies, so the conversation below it survives), else `wrap`.
 */
export function threadItem(
  h: Hydrated,
  uri: string,
  replies: Array<ThreadItem> | undefined,
  wrap: (post: PostView, replies: Array<ThreadItem>) => ThreadItem
): ThreadItem {
  const p = h.posts.get(uri)
  if (!p?.active) return notFound(uri, replies)
  if (h.isHidden(p)) return hidden(uri, h.communityOf(p)?.uri, replies)
  const view = h.view(uri)
  return view ? wrap(view, replies ?? []) : notFound(uri, replies)
}

/** "community post" pairs that a creator hid. */
async function loadLabels(postUris: Array<string>) {
  if (postUris.length === 0) return new Set<string>()
  const rows = await db
    .select({
      community: schema.communityHiddenPost.communityUri,
      post: schema.communityHiddenPost.postUri,
    })
    .from(schema.communityHiddenPost)
    .where(inArray(schema.communityHiddenPost.postUri, postUris))
  return new Set(rows.map((r) => `${r.community} ${r.post}`))
}

/** The post record as indexed, rebuilt from its columns. */
function toRecord(p: PostRow) {
  return {
    $type: sh.authentiq.feed.post.$type,
    text: p.text,
    ...(p.facets ? { facets: p.facets } : {}),
    ...(p.replyRootUri
      ? {
          reply: {
            root: { uri: p.replyRootUri, cid: p.replyRootCid },
            parent: { uri: p.replyParentUri, cid: p.replyParentCid },
          },
        }
      : {}),
    ...(p.communityUri
      ? { community: { uri: p.communityUri, cid: p.communityCid } }
      : {}),
    ...(p.embed ? { embed: p.embed } : {}),
    createdAt: p.createdAt.toISOString(),
  }
}

/** Only kinds we know become views; the embed union is open. */
function toEmbedView(embed: unknown) {
  const e = embed as sh.authentiq.embed.external.Main | null
  if (e?.$type !== sh.authentiq.embed.external.$type) return undefined
  return {
    $type: "sh.authentiq.embed.external#view" as const,
    external: {
      uri: e.external.uri,
      title: e.external.title,
      description: e.external.description,
    },
  }
}

/** `sortAt::uri` keyset cursors for newest-first lists. */
export const cursor = {
  encode: (row: { sortAt: Date; uri: string }) =>
    `${row.sortAt.getTime()}::${row.uri}`,
  decode(value: string | undefined) {
    if (!value) return undefined
    const i = value.indexOf("::")
    const ms = Number(value.slice(0, i))
    if (i < 0 || !Number.isFinite(ms)) return undefined
    return { sortAt: new Date(ms), uri: value.slice(i + 2) }
  },
  /** `(sort_at, uri) < cursor`, matching an `order by sort_at desc, uri desc`. */
  before(
    columns: { sortAt: AnyPgColumn; uri: AnyPgColumn },
    c: { sortAt: Date; uri: string }
  ) {
    return sql`(${columns.sortAt}, ${columns.uri}) < (${c.sortAt.toISOString()}::timestamptz, ${c.uri})`
  },
}
