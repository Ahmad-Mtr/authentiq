import type { Agent } from "@atproto/api"
import { sh } from "@workspace/lexicons"
import { z } from "zod"
import type {
  FeedEntryUI,
  FeedPageUI,
  GeneratorUI,
} from "../lib/feed-types.ts"
import { ApiError, appViewError, callAppView } from "./appview.ts"
import { env } from "./env.ts"
import { toJob } from "./jobs.ts"
import { parseInput, queryAppView, toFeed } from "./social.ts"

/**
 * Feeds, BFF side (phase 8). Server-only: API routes and server functions
 * import it; route components never do.
 *
 * Reading a feed: the generator's view (from the AppView's index) says which
 * service builds it. Signed in, the user's PDS signs a 60-second, single-use
 * token for *that service* (aud = the generator's DID, lxm =
 * getFeedSkeleton), and the AppView verifies it and forwards it. The BFF
 * never tells anyone who the viewer is; the user's PDS does. Signed out, the
 * request is anonymous and each feed answers as it documents.
 *
 * The home timeline is the AppView's own `getTimeline`, with the usual
 * AppView token.
 */

const FEED = sh.authentiq.feed

type Json = Record<string, any>

export const toGenerator = (g: Json): GeneratorUI => ({
  uri: g.uri,
  did: g.did,
  creator: {
    did: g.creator.did,
    handle: g.creator.handle,
    displayName: g.creator.displayName,
    headline: g.creator.headline,
  },
  displayName: g.displayName,
  description: g.description,
  pinned: g.viewer?.pinned ?? false,
})

/** A hydrated feed's items; kinds this app does not know are skipped (the union is open). */
export function toEntries(feed: Array<Json>): Array<FeedEntryUI> {
  return feed.flatMap((item): Array<FeedEntryUI> => {
    if (item.$type === "sh.authentiq.feed.defs#feedViewPost") {
      return [{ kind: "post", ...toFeed([item])[0] }]
    }
    if (item.$type === "sh.authentiq.job.defs#jobView") {
      return [{ kind: "job", job: toJob(item) }]
    }
    return []
  })
}

async function readError(res: Response) {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string
    message?: string
  }
  return {
    ok: false as const,
    error: body.error ?? "FeedUnavailable",
    message: body.message ?? "This feed is unavailable right now",
  }
}

export async function fetchGenerator(agent: Agent | undefined, uri: string) {
  const res = await queryAppView<{ view: Json }>(
    agent,
    FEED.getFeedGenerator.$lxm,
    { feed: uri }
  )
  return res.ok ? toGenerator(res.data.view) : null
}

/** One page of a feed, hydrated by the AppView. */
export async function fetchFeed(
  agent: Agent | undefined,
  opts: { feed: string; cursor?: string; limit?: number; did?: string }
): Promise<FeedPageUI> {
  const url = new URL(`/xrpc/${FEED.getFeed.$lxm}`, env.APPVIEW_URL)
  url.searchParams.set("feed", opts.feed)
  url.searchParams.set("limit", String(opts.limit ?? 20))
  if (opts.cursor) url.searchParams.set("cursor", opts.cursor)

  const headers: Record<string, string> = {}
  if (agent) {
    const did = opts.did ?? (await fetchGenerator(agent, opts.feed))?.did
    if (!did) {
      return { ok: false, error: "UnknownFeed", message: "There is no such feed" }
    }
    // Addressed to the feed's generator, not the AppView: see above.
    const { data } = await agent.com.atproto.server.getServiceAuth({
      aud: did,
      lxm: FEED.getFeedSkeleton.$lxm,
      exp: Math.floor(Date.now() / 1000) + 60,
    })
    headers.authorization = `Bearer ${data.token}`
  }
  const res = await fetch(url, { headers })
  if (!res.ok) return readError(res)
  const body = (await res.json()) as { feed: Array<Json>; cursor?: string }
  return { ok: true, entries: toEntries(body.feed), cursor: body.cursor }
}

/** The signed-in user's home timeline. */
export async function fetchTimeline(
  agent: Agent,
  opts: { cursor?: string; limit?: number } = {}
): Promise<FeedPageUI> {
  const res = await callAppView(agent, FEED.getTimeline.$lxm, {
    query: {
      limit: String(opts.limit ?? 20),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    },
  })
  if (!res.ok) return readError(res)
  const body = (await res.json()) as { feed: Array<Json>; cursor?: string }
  return {
    ok: true,
    entries: toFeed(body.feed).map((i) => ({ kind: "post" as const, ...i })),
    cursor: body.cursor,
  }
}

/** Every feed the AppView knows, oldest first, with the viewer's pins marked. */
export async function fetchDirectory(agent: Agent | undefined) {
  const res = await queryAppView<{ feeds: Array<Json> }>(
    agent,
    FEED.listFeedGenerators.$lxm,
    { limit: 100 }
  )
  return res.ok ? res.data.feeds.map(toGenerator) : []
}

export async function fetchPinned(agent: Agent) {
  const res = await callAppView(agent, FEED.getPinnedFeeds.$lxm)
  if (!res.ok) throw await appViewError(res)
  return ((await res.json()) as { feeds: Array<Json> }).feeds.map(toGenerator)
}

const pinInput = z.object({
  feed: z.string().regex(/^at:\/\/[^/]+\/sh\.authentiq\.feed\.generator\/[^/]+$/),
  pinned: z.boolean(),
})

/** Pin or unpin one feed. A new pin goes to the end of the list. */
export async function setPinned(agent: Agent, raw: unknown) {
  const { feed, pinned } = parseInput(pinInput, raw)
  const current = (await fetchPinned(agent)).map((g) => g.uri)
  const next = pinned
    ? current.includes(feed)
      ? current
      : [...current, feed]
    : current.filter((u) => u !== feed)
  const res = await callAppView(agent, FEED.putPinnedFeeds.$lxm, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feeds: next }),
  })
  if (!res.ok) {
    const err = await appViewError(res)
    throw new ApiError(err.status, err.error, err.message)
  }
  return (await res.json()) as { feeds: Array<string> }
}
