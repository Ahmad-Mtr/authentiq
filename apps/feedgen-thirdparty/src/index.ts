import { IdResolver, MemoryCache } from "@atproto/identity"
import { Firehose, MemoryRunner } from "@atproto/sync"
import type { Event } from "@atproto/sync"
import { env } from "./env.ts"

/**
 * A third-party feed generator: "Posts with a link", newest first.
 *
 * It is here to show that a feed can be added to Authentiq by somebody else
 * with no change to the AppView or the web app. So it uses only what anyone
 * on the network can use:
 *
 * - **Live:** the PDS firehose (`com.atproto.sync.subscribeRepos`), with
 *   commit signatures verified against PLC, for new and deleted posts.
 * - **History:** the firehose only replays about a day, so on start it reads
 *   existing posts through the PDS's public repo API (`listRepos`,
 *   `listRecords`), the same data a relay or an AppView backfill reads.
 *
 * It keeps a small index in memory: the URI and time of every post whose
 * record carries a link (a link facet, or a link card). It does not
 * validate posts, apply hides or check accounts: the AppView does all of
 * that when it hydrates this skeleton, for every feed alike.
 *
 * It serves anonymous requests only: the feed is the same for everyone, so
 * it never needs to know who is reading.
 */

const FEED_NAME = "with-links"
const POST = "sh.authentiq.feed.post"
const GENERATOR = "sh.authentiq.feed.generator"

type Item = { uri: string; did: string; sortAt: number }
const items = new Map<string, Item>()

/** A post record carries a link: a link facet, or an external link card. */
function hasLink(record: unknown) {
  const r = record as {
    $type?: string
    facets?: Array<{ features?: Array<{ $type?: string }> }>
    embed?: { $type?: string }
  }
  if (r.$type !== POST) return false
  if (r.embed?.$type === "sh.authentiq.embed.external") return true
  return (r.facets ?? []).some((f) =>
    (f.features ?? []).some((x) => x.$type === "sh.authentiq.richtext.facet#link")
  )
}

function remember(uri: string, did: string, record: unknown) {
  if (!hasLink(record)) return
  const createdAt = Date.parse(String((record as { createdAt?: string }).createdAt))
  // Never trust a future timestamp to pin a post to the top.
  const sortAt = Math.min(Number.isFinite(createdAt) ? createdAt : Date.now(), Date.now())
  items.set(uri, { uri, did, sortAt })
}

async function pds<T>(method: string, params: Record<string, string>) {
  const url = new URL(`/xrpc/${method}`, env.PDS_URL)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${method}: ${res.status}`)
  return (await res.json()) as T
}

/** Existing posts, through the PDS's public repo API. */
async function backfill() {
  let cursor: string | undefined
  let repos = 0
  do {
    const page = await pds<{
      repos: Array<{ did: string; active?: boolean }>
      cursor?: string
    }>("com.atproto.sync.listRepos", { limit: "500", ...(cursor ? { cursor } : {}) })
    for (const repo of page.repos) {
      if (repo.active === false) continue
      repos++
      let rc: string | undefined
      do {
        const recs = await pds<{
          records: Array<{ uri: string; value: unknown }>
          cursor?: string
        }>("com.atproto.repo.listRecords", {
          repo: repo.did,
          collection: POST,
          limit: "100",
          ...(rc ? { cursor: rc } : {}),
        })
        for (const r of recs.records) remember(r.uri, repo.did, r.value)
        rc = recs.records.length === 100 ? recs.cursor : undefined
      } while (rc)
    }
    cursor = page.repos.length === 500 ? page.cursor : undefined
  } while (cursor)
  console.log(`[links] backfilled ${repos} repos: ${items.size} posts with a link`)
}

// Live, from the firehose. Started before the backfill, so nothing written
// in between is missed; a post seen by both is stored once.
const firehose = new Firehose({
  idResolver: new IdResolver({
    plcUrl: env.PLC_URL,
    didCache: new MemoryCache(),
    // Our own fetch for PLC; @atproto/identity's default cannot run under Bun.
    fetch: globalThis.fetch,
  }),
  runner: new MemoryRunner({}),
  service: env.PDS_URL.replace(/^http/, "ws"),
  filterCollections: [POST],
  unauthenticatedHandles: true,
  handleEvent: async (evt: Event) => {
    if (evt.event === "create") remember(evt.uri.toString(), evt.did, evt.record)
    else if (evt.event === "delete") items.delete(evt.uri.toString())
    // A deleted account's posts go with it (no per-record deletes are sent).
    // Deactivation is left to the AppView, which hides it and can undo it.
    else if (evt.event === "account" && evt.status === "deleted") {
      for (const [uri, item] of items) if (item.did === evt.did) items.delete(uri)
    }
  },
  onError: (err) => console.error(`[links] firehose: ${err.message}`),
})
void firehose.start()
void backfill().catch((err) => console.error("[links] backfill failed:", err))

/** The publisher's DID, resolved through the PDS once it exists. */
let publisher: string | undefined
async function publisherDid() {
  publisher ??= await pds<{ did: string }>("com.atproto.identity.resolveHandle", {
    handle: env.PUBLISHER,
  })
    .then((r) => r.did)
    .catch(() => undefined)
  return publisher
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

const server = Bun.serve({
  port: env.PORT,
  async fetch(req) {
    const url = new URL(req.url)
    switch (url.pathname) {
      case "/xrpc/_health":
        return json({
          service: "feedgen-thirdparty",
          did: env.SERVICE_DID,
          posts: items.size,
          publisher: (await publisherDid()) ?? null,
        })
      case "/.well-known/did.json":
        return json({
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: env.SERVICE_DID,
          service: [
            {
              id: "#authentiq_fg",
              type: "AuthentiqFeedGenerator",
              serviceEndpoint: env.PUBLIC_URL,
            },
          ],
        })
      case "/xrpc/sh.authentiq.feed.describeFeedGenerator": {
        const did = await publisherDid()
        return json({
          did: env.SERVICE_DID,
          feeds: did ? [{ uri: `at://${did}/${GENERATOR}/${FEED_NAME}` }] : [],
        })
      }
      case "/xrpc/sh.authentiq.feed.getFeedSkeleton":
        return skeleton(url.searchParams)
      default:
        return json({ error: "MethodNotImplemented" }, 404)
    }
  },
})

async function skeleton(params: URLSearchParams) {
  const feed = params.get("feed") ?? ""
  if (feed !== `at://${await publisherDid()}/${GENERATOR}/${FEED_NAME}`) {
    return json({ error: "UnknownFeed", message: "Not a feed served here" }, 400)
  }
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 50) || 50, 1), 100)
  // Cursor: "<ms>::<uri>" of the last item returned, newest first.
  const cursor = params.get("cursor")
  const [ms, after] = cursor ? [Number(cursor.split("::")[0]), cursor.split("::")[1]] : []
  const sorted = [...items.values()].sort(
    (a, b) => b.sortAt - a.sortAt || (a.uri < b.uri ? 1 : -1)
  )
  const page = sorted
    .filter((i) =>
      ms === undefined ? true : i.sortAt < ms || (i.sortAt === ms && i.uri < (after ?? ""))
    )
    .slice(0, limit)
  const last = page.at(-1)
  return json({
    feed: page.map((i) => ({ $type: "sh.authentiq.feed.defs#skeletonPost", post: i.uri })),
    cursor: page.length === limit && last ? `${last.sortAt}::${last.uri}` : undefined,
  })
}

console.log(`feedgen-thirdparty listening on http://localhost:${server.port}`)
