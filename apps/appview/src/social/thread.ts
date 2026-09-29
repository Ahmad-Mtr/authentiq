import { eq, inArray, or } from "drizzle-orm"
import { schema } from "@workspace/db"
import { db } from "../db.ts"
import { hydratePosts, loadPosts, notFound, threadItem } from "./hydrate.ts"
import type { PostRow, ThreadItem } from "./hydrate.ts"

/** More posts than this in one thread are not assembled. */
const MAX_THREAD_POSTS = 2000

/**
 * sh.authentiq.feed.getPostThread, assembled from whatever is indexed right
 * now:
 *
 * - A thread is every post whose `reply.root` names the root, plus the root.
 * - A reply hangs from its `reply.parent`. If the parent is in the thread it
 *   goes under it. If the parent exists but belongs to another thread, the
 *   reply's root and parent disagree and it is left out. If the parent is
 *   not indexed (deleted, not arrived yet, invalid), a not-found placeholder
 *   stands in for it and keeps its replies. We cannot know where a missing
 *   post sat, so its placeholder hangs from the root.
 * - Posts by deactivated accounts are not-found placeholders; posts the
 *   community's creator hid are hidden placeholders. Both keep their replies.
 *
 * Returns undefined when the requested post itself is not available.
 */
export async function getPostThread(opts: {
  uri: string
  depth: number
  parentHeight: number
  viewer: string | undefined
}) {
  const anchor = (await loadPosts([opts.uri])).get(opts.uri)
  if (!anchor?.active) return undefined
  const rootUri = anchor.replyRootUri ?? anchor.uri

  const rows = await db
    .select({ post: schema.post, active: schema.actor.active })
    .from(schema.post)
    .innerJoin(schema.actor, eq(schema.actor.did, schema.post.did))
    .where(
      or(eq(schema.post.uri, rootUri), eq(schema.post.replyRootUri, rootUri))
    )
    .limit(MAX_THREAD_POSTS)
  const thread = new Map<string, PostRow>(
    rows.map((r) => [r.post.uri, { ...r.post, active: r.active }])
  )
  thread.set(anchor.uri, anchor)

  // Parents named by replies that are not in this thread: either missing
  // (placeholder) or in another thread (the reply is inconsistent; drop it).
  const unknownParents = [
    ...new Set(
      [...thread.values()].flatMap((p) =>
        p.replyParentUri && !thread.has(p.replyParentUri)
          ? [p.replyParentUri]
          : []
      )
    ),
  ]
  const elsewhere = new Set(
    unknownParents.length === 0
      ? []
      : (
          await db
            .select({ uri: schema.post.uri })
            .from(schema.post)
            .where(inArray(schema.post.uri, unknownParents))
        ).map((r) => r.uri)
  )
  const missing = unknownParents.filter((u) => !elsewhere.has(u))

  const children = new Map<string, Array<PostRow>>()
  for (const p of thread.values()) {
    if (!p.replyParentUri || elsewhere.has(p.replyParentUri)) continue
    const list = children.get(p.replyParentUri) ?? []
    list.push(p)
    children.set(p.replyParentUri, list)
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.sortAt.getTime() - b.sortAt.getTime())
  }

  const h = await hydratePosts(thread.values(), opts.viewer)

  const repliesOf = (uri: string, depthLeft: number): Array<ThreadItem> => {
    if (depthLeft <= 0) return []
    const items = (children.get(uri) ?? []).map((c) =>
      node(c.uri, depthLeft - 1)
    )
    if (uri === rootUri) {
      for (const m of missing) {
        if (m !== rootUri) items.push(notFound(m, repliesOf(m, depthLeft - 1)))
      }
    }
    return items
  }

  const node = (uri: string, depthLeft: number): ThreadItem =>
    threadItem(h, uri, repliesOf(uri, depthLeft), (post, replies) => ({
      $type: "sh.authentiq.feed.defs#threadViewPost",
      post,
      ...(replies.length ? { replies } : {}),
    }))

  const parentOf = (p: PostRow, heightLeft: number): ThreadItem | undefined => {
    if (!p.replyParentUri || heightLeft <= 0) return undefined
    const parent = thread.get(p.replyParentUri)
    if (!parent) return notFound(p.replyParentUri)
    return threadItem(h, parent.uri, undefined, (post) => ({
      $type: "sh.authentiq.feed.defs#threadViewPost",
      post,
      parent: parentOf(parent, heightLeft - 1),
    }))
  }

  const top = node(anchor.uri, opts.depth)
  if (top.$type === "sh.authentiq.feed.defs#threadViewPost") {
    const parent = parentOf(anchor, opts.parentHeight)
    if (parent) top.parent = parent
  }
  return top
}
