import { RichText } from "@atproto/api"
import type { Agent } from "@atproto/api"
import { getPdsEndpoint, resolveDid } from "@workspace/atproto"
import { sh } from "@workspace/lexicons"
import type { z } from "zod"
import type {
  ActorUI,
  CommunityUI,
  FeedItemUI,
  PlaceholderUI,
  PostUI,
  ThreadUI,
} from "../lib/social-types.ts"
import { ApiError, appViewError, callAppView } from "./appview.ts"
import { env } from "./env.ts"
import {
  buildCommunityRecord,
  buildFollowRecord,
  buildLikeRecord,
  buildMembershipRecord,
  buildPostRecord,
  communityInput,
  deleteInput,
  followInput,
  hideInput,
  likeInput,
  membershipInput,
  postInput,
} from "./records.ts"

/**
 * The social layer, BFF side (phase 6). Server-only: API routes and server
 * functions import it; route components never do.
 *
 * Writes go to the user's repo through the `$parse`d builders in records.ts.
 * Reads go to the AppView, with a service auth token for the query's own
 * method when someone is signed in, so views carry their viewer state.
 */

const POST = sh.authentiq.feed.post
const LIKE = sh.authentiq.feed.like
const FOLLOW = sh.authentiq.graph.follow
const COMMUNITY = sh.authentiq.community
const FEED = sh.authentiq.feed

/** Validates a JSON body against a zod schema, as a 400 with issues. */
export function parseInput<T extends z.ZodType>(schema: T, raw: unknown) {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new ApiError(
      400,
      "InvalidRequest",
      parsed.error.issues[0]?.message ?? "Invalid request",
      parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }))
    )
  }
  return parsed.data
}

// --- reads ---------------------------------------------------------------------

/**
 * GET an AppView query. Signed in: with service auth for exactly this method,
 * so the response has viewer state. Signed out: a plain public request.
 */
export async function queryAppView<T>(
  agent: Agent | undefined,
  lxm: string,
  params: Record<string, string | number | undefined>
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const query = Object.fromEntries(
    Object.entries(params).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, String(v)]]
    )
  )
  let res: Response
  if (agent) {
    res = await callAppView(agent, lxm, { query })
  } else {
    const url = new URL(`/xrpc/${lxm}`, env.APPVIEW_URL)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    res = await fetch(url)
  }
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return { ok: false, error: body.error ?? "InvalidRequest" }
  }
  if (!res.ok) throw await appViewError(res)
  return { ok: true, data: (await res.json()) as T }
}

// --- helpers for writes --------------------------------------------------------

/**
 * A record straight from its author's PDS (public `getRecord`), for its CID
 * and contents. The repo is authoritative, and the AppView may not have
 * indexed it yet.
 */
async function fetchRecord(uri: string) {
  const [, , repo, collection, rkey] = uri.split("/")
  const doc = await resolveDid(repo, { plcUrl: env.PLC_URL })
  const pds = getPdsEndpoint(doc) ?? env.PDS_URL
  const url = new URL("/xrpc/com.atproto.repo.getRecord", pds)
  url.searchParams.set("repo", repo)
  url.searchParams.set("collection", collection)
  url.searchParams.set("rkey", rkey)
  const res = await fetch(url)
  if (!res.ok) {
    throw new ApiError(400, "RecordNotFound", `Record not found: ${uri}`)
  }
  return (await res.json()) as { uri: string; cid: string; value: unknown }
}

/**
 * Waits (briefly) until the AppView can show what was just written, so the
 * page the user lands on includes it. The write has already succeeded; a
 * slow index only means the page shows it a moment later.
 */
async function waitFor(probe: () => Promise<boolean>, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await probe().catch(() => false)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const publicQuery = async (lxm: string, params: Record<string, string>) => {
  const url = new URL(`/xrpc/${lxm}`, env.APPVIEW_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return (await fetch(url)).ok
}

/**
 * RichText's mention and link facets, in our namespace. Mentions are
 * resolved handle → DID by the user's PDS while composing; a handle that
 * does not resolve stays plain text. Hashtags are detected by RichText but
 * our lexicon has no tag feature yet, so they are dropped.
 */
async function detectFacets(agent: Agent, text: string) {
  const rt = new RichText({ text })
  await rt.detectFacets(agent)
  const facets: NonNullable<sh.authentiq.feed.post.Main["facets"]> = []
  type Feature =
    | { $type: "sh.authentiq.richtext.facet#mention"; did: string }
    | { $type: "sh.authentiq.richtext.facet#link"; uri: string }
  for (const facet of rt.facets ?? []) {
    const features = facet.features.flatMap((f): Array<Feature> => {
      if (f.$type === "app.bsky.richtext.facet#mention") {
        const did = (f as { did: string }).did
        return did.startsWith("did:")
          ? [{ $type: "sh.authentiq.richtext.facet#mention", did }]
          : []
      }
      if (f.$type === "app.bsky.richtext.facet#link") {
        const uri = (f as { uri: string }).uri
        return [{ $type: "sh.authentiq.richtext.facet#link", uri }]
      }
      return []
    })
    if (features.length > 0) {
      facets.push({
        index: {
          byteStart: facet.index.byteStart,
          byteEnd: facet.index.byteEnd,
        },
        features,
      } as (typeof facets)[number])
    }
  }
  return facets
}

// --- writes --------------------------------------------------------------------

export async function createPost(agent: Agent, raw: unknown) {
  const input = parseInput(postInput, raw)
  if (input.replyTo && input.community) {
    throw new ApiError(
      400,
      "InvalidRequest",
      "A reply belongs to its thread's community; do not set one"
    )
  }

  let reply: { root: StrongRef; parent: StrongRef } | undefined
  if (input.replyTo) {
    const parent = await fetchRecord(input.replyTo)
    const value = POST.$safeParse(parent.value)
    if (!value.success) {
      throw new ApiError(400, "InvalidParent", "That post cannot be replied to")
    }
    const parentRef = { uri: parent.uri, cid: parent.cid }
    reply = { root: value.value.reply?.root ?? parentRef, parent: parentRef }
  }

  let community: StrongRef | undefined
  if (input.community) {
    // The AppView would hide a non-member's post from the community anyway;
    // refusing here saves the user a post nobody in it would see.
    const view = await queryAppView<sh.authentiq.community.defs.CommunityView>(
      agent,
      COMMUNITY.getCommunity.$lxm,
      { uri: input.community }
    )
    if (!view.ok) {
      throw new ApiError(400, "CommunityNotFound", "Unknown community")
    }
    if (!view.data.viewer?.membership && !view.data.viewer?.isCreator) {
      throw new ApiError(
        403,
        "NotAMember",
        "Join the community before posting in it"
      )
    }
    community = { uri: view.data.uri, cid: view.data.cid }
  }

  const record = buildPostRecord({
    text: input.text,
    facets: await detectFacets(agent, input.text),
    reply,
    community,
    link: input.link,
  })
  const { data } = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: POST.$nsid,
    record,
  })
  const indexed = await waitFor(() =>
    publicQuery(FEED.getPostThread.$lxm, { uri: data.uri, depth: "0" })
  )
  return { uri: data.uri, cid: data.cid, indexed }
}

type StrongRef = { uri: string; cid: string }

/**
 * Deletes one of the user's own records. Scoped to `sh.authentiq.*` and to
 * the signed-in repo, so a crafted URI cannot delete anything else.
 */
export async function deleteOwnRecord(agent: Agent, raw: unknown) {
  const { uri } = parseInput(deleteInput, raw)
  const [, , repo, collection, rkey] = uri.split("/")
  if (!collection.startsWith("sh.authentiq.") || !rkey) {
    throw new ApiError(
      400,
      "InvalidRequest",
      "Refusing to delete a record outside our namespace"
    )
  }
  if (repo !== agent.assertDid) {
    throw new ApiError(403, "Forbidden", "You can only delete your own records")
  }
  // Unlike, unfollow, leave: note what the record pointed at, so we can
  // wait below until the viewer's state no longer shows it.
  const kind = VIEWER_STATE[collection]
  const record = kind ? (await fetchRecord(uri)).value : undefined
  await agent.com.atproto.repo.deleteRecord({
    repo: agent.assertDid,
    collection,
    rkey,
  })
  if (collection === POST.$nsid) {
    await waitFor(
      async () =>
        !(await publicQuery(FEED.getPostThread.$lxm, { uri, depth: "0" }))
    )
  } else if (kind && record) {
    await waitForViewer(agent, kind, subjectOf(record), (v) => v !== uri)
  }
  return { deleted: uri }
}

/**
 * Likes, follows and memberships appear as viewer state, so writes to them
 * wait until the AppView shows the change: a reload right after clicking
 * then shows what the user just did.
 */
const VIEWER_STATE: Partial<
  Record<string, "like" | "following" | "membership">
> = {
  [LIKE.$nsid]: "like",
  [FOLLOW.$nsid]: "following",
  [COMMUNITY.membership.$nsid]: "membership",
}

/** The post, account or community a like, follow or membership points at. */
function subjectOf(record: unknown) {
  const r = record as {
    subject?: string | { uri: string }
    community?: { uri: string }
  }
  if (typeof r.subject === "string") return r.subject
  return r.subject?.uri ?? r.community?.uri ?? ""
}

async function waitForViewer(
  agent: Agent,
  kind: "like" | "following" | "membership",
  subject: string,
  done: (value: string | undefined) => boolean
) {
  return waitFor(async () => {
    if (kind === "like") {
      const res = await queryAppView<{
        thread: { post?: { viewer?: { like?: string } } }
      }>(agent, FEED.getPostThread.$lxm, { uri: subject, depth: 0 })
      return res.ok && done(res.data.thread.post?.viewer?.like)
    }
    if (kind === "following") {
      const res = await queryAppView<{ viewer?: { following?: string } }>(
        agent,
        sh.authentiq.actor.getProfile.$lxm,
        { actor: subject }
      )
      return res.ok && done(res.data.viewer?.following)
    }
    const res = await queryAppView<{ viewer?: { membership?: string } }>(
      agent,
      COMMUNITY.getCommunity.$lxm,
      { uri: subject }
    )
    return res.ok && done(res.data.viewer?.membership)
  })
}

export async function likePost(agent: Agent, raw: unknown) {
  const { subject } = parseInput(likeInput, raw)
  const post = await fetchRecord(subject)
  const { data } = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: LIKE.$nsid,
    record: buildLikeRecord({ uri: post.uri, cid: post.cid }),
  })
  const indexed = await waitForViewer(agent, "like", subject, Boolean)
  return { uri: data.uri, indexed }
}

export async function followActor(agent: Agent, raw: unknown) {
  const { subject } = parseInput(followInput, raw)
  const did = subject.startsWith("did:")
    ? subject
    : (await agent.com.atproto.identity.resolveHandle({ handle: subject })).data
        .did
  if (did === agent.assertDid) {
    throw new ApiError(400, "InvalidRequest", "You cannot follow yourself")
  }
  const { data } = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: FOLLOW.$nsid,
    record: buildFollowRecord(did),
  })
  const indexed = await waitForViewer(agent, "following", did, Boolean)
  return { uri: data.uri, indexed }
}

export async function createCommunity(agent: Agent, raw: unknown) {
  const input = parseInput(communityInput, raw)
  const { data } = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: COMMUNITY.declaration.$nsid,
    record: buildCommunityRecord(input),
  })
  const indexed = await waitFor(() =>
    publicQuery(COMMUNITY.getCommunity.$lxm, { uri: data.uri })
  )
  return { uri: data.uri, cid: data.cid, indexed }
}

export async function joinCommunity(agent: Agent, raw: unknown) {
  const { community } = parseInput(membershipInput, raw)
  const declaration = await fetchRecord(community)
  const { data } = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: COMMUNITY.membership.$nsid,
    record: buildMembershipRecord({
      uri: declaration.uri,
      cid: declaration.cid,
    }),
  })
  // Posting into a community is checked against the AppView's view of the
  // membership, so the join is not done until the index agrees.
  const indexed = await waitForViewer(
    agent,
    "membership",
    community,
    (v) => v === data.uri
  )
  return { uri: data.uri, indexed }
}

/** Community moderation, via the AppView with the creator's service auth. */
export async function setPostHidden(agent: Agent, raw: unknown) {
  const input = parseInput(hideInput, raw)
  const lxm = input.hidden ? COMMUNITY.hidePost.$lxm : COMMUNITY.unhidePost.$lxm
  const res = await callAppView(agent, lxm, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ community: input.community, post: input.post }),
  })
  if (!res.ok) throw await appViewError(res)
  return (await res.json()) as { hidden: boolean }
}

// --- views for the pages -------------------------------------------------------
//
// The AppView validated these against the lexicons before sending them; here
// they become the plain shapes in lib/social-types.ts.

type Json = Record<string, any>

const toActor = (a: Json): ActorUI => ({
  did: a.did,
  handle: a.handle,
  displayName: a.displayName,
  headline: a.headline,
})

export function toPost(p: Json): PostUI {
  const record = p.record as Json
  const external =
    p.embed?.$type === "sh.authentiq.embed.external#view"
      ? (p.embed.external as Json)
      : undefined
  return {
    uri: p.uri,
    cid: p.cid,
    author: toActor(p.author),
    text: record.text,
    facets: record.facets ?? [],
    createdAt: record.createdAt,
    reply: record.reply
      ? { root: record.reply.root.uri, parent: record.reply.parent.uri }
      : undefined,
    link: external
      ? {
          uri: external.uri,
          title: external.title,
          description: external.description,
        }
      : undefined,
    community: p.community
      ? {
          uri: p.community.uri,
          name: p.community.name,
          topic: p.community.topic,
        }
      : undefined,
    replyCount: p.replyCount ?? 0,
    like: p.viewer?.like,
  }
}

const placeholder = (n: Json): PlaceholderUI | undefined =>
  n.$type === "sh.authentiq.feed.defs#notFoundPost"
    ? { kind: "notFound", uri: n.uri }
    : n.$type === "sh.authentiq.feed.defs#hiddenPost"
      ? { kind: "hidden", uri: n.uri, community: n.community }
      : undefined

export function toThread(n: Json): ThreadUI {
  const replies = ((n.replies ?? []) as Array<Json>).map(toThread)
  const ph = placeholder(n)
  if (ph) return { ...ph, replies }
  return {
    kind: "post",
    post: toPost(n.post),
    parent: n.parent ? toThread(n.parent) : undefined,
    replies,
  }
}

export function toFeed(feed: Array<Json>): Array<FeedItemUI> {
  return feed.map((item) => {
    const parent = item.reply?.parent as Json | undefined
    return {
      post: toPost(item.post),
      replyTo: parent
        ? (placeholder(parent) ?? { kind: "post", post: toPost(parent) })
        : undefined,
    }
  })
}

export const toCommunity = (c: Json): CommunityUI => ({
  uri: c.uri,
  cid: c.cid,
  creator: toActor(c.creator),
  name: c.name,
  topic: c.topic,
  description: c.description,
  rules: c.rules ?? [],
  createdAt: c.createdAt,
  membership: c.viewer?.membership,
  isCreator: c.viewer?.isCreator ?? false,
})
