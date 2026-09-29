import { Elysia, status, t } from "elysia"
import { sh } from "@workspace/lexicons"
import { resolveViewer, verifyServiceAuth } from "../auth.ts"
import {
  getPinned,
  listGenerators,
  putPinned,
  toGeneratorViews,
} from "../feeds/generators.ts"
import { hydrateSkeleton } from "../feeds/hydrate.ts"
import { FeedError, loadGenerator, resolveEndpoint } from "../feeds/resolve.ts"
import { MAX_CURSOR, fetchSkeleton } from "../feeds/skeleton.ts"
import { getTimeline } from "../social/feeds.ts"

/**
 * Phase 8: feed composition.
 *
 * `getFeed` is the path from a generator record to a hydrated feed:
 *
 *   feed.generator record (index) → its `did` → DID document (fetch guard,
 *   cached) → #authentiq_fg endpoint → getFeedSkeleton (fetch guard, 3 s,
 *   256 KiB) → clamp → hydrate under this AppView's policy
 *
 * Viewer identity follows Bluesky: the client asks the viewer's PDS for a
 * service auth token addressed to the *generator* (aud = its DID, lxm =
 * getFeedSkeleton). The AppView verifies it (signature, expiry, method, and
 * that the audience is this feed's generator), uses its issuer for viewer
 * state, marks its `jti` used, and forwards it unchanged. The generator
 * verifies it again for itself. A token that fails here is a 401, never a
 * silent logged-out feed; no token means an anonymous request, which each
 * generator answers as it documents.
 *
 * `getTimeline` is served here, from the index, with the usual AppView
 * token (aud = this AppView). The rest are reads of the index and the pins.
 */

const FEED = sh.authentiq.feed

const atUri = t.String({ pattern: "^at://", maxLength: 8192 })
const limit = (max: number) =>
  t.Optional(t.Numeric({ minimum: 1, maximum: max }))
const cursor = t.Optional(t.String({ maxLength: MAX_CURSOR }))

const feedError = (feed: string, err: FeedError) => {
  console.warn(
    `[feeds] ${feed}: ${err.error} — ${err.message}${err.detail ? ` (${err.detail})` : ""}`
  )
  return status(err.status, { error: err.error, message: err.message })
}

export const feedRoutes = new Elysia()
  .get(
    `/xrpc/${FEED.getFeed.$lxm}`,
    async ({ query, headers }) => {
      const gen = await loadGenerator(query.feed)
      if (!gen) {
        return status(400, {
          error: "UnknownFeed",
          message: `Unknown feed: ${query.feed}`,
        })
      }
      // The token is for the generator; check it before anything is sent.
      const auth = await resolveViewer(
        headers.authorization,
        FEED.getFeedSkeleton.$lxm,
        gen.serviceDid
      )
      if (!("viewer" in auth)) return status(401, auth)
      try {
        const endpoint = await resolveEndpoint(gen.serviceDid)
        const skeleton = await fetchSkeleton({
          endpoint,
          feed: gen.uri,
          limit: query.limit ?? 30,
          cursor: query.cursor,
          // Only a verified, active viewer's token is passed on.
          authorization: auth.viewer ? headers.authorization : undefined,
        })
        const { feed, withheld } = await hydrateSkeleton(
          skeleton.items,
          auth.viewer
        )
        const dropped = Object.entries(skeleton.dropped)
        if (dropped.length || withheld) {
          console.log(
            `[feeds] ${gen.uri}: dropped ${dropped.map(([k, v]) => `${v} ${k}`).join(", ") || "none"}; policy withheld ${withheld}`
          )
        }
        return FEED.getFeed.$output.schema.parse({
          feed,
          cursor: skeleton.cursor,
        })
      } catch (err) {
        if (err instanceof FeedError) return feedError(gen.uri, err)
        throw err
      }
    },
    {
      query: t.Object({ feed: atUri, limit: limit(100), cursor }),
    }
  )
  .get(
    `/xrpc/${FEED.getTimeline.$lxm}`,
    async ({ query, headers }) => {
      const auth = await resolveViewer(
        headers.authorization,
        FEED.getTimeline.$lxm
      )
      if (!("viewer" in auth)) return status(401, auth)
      if (!auth.viewer) {
        return status(401, {
          error: "AuthRequired",
          message: "The timeline is the signed-in account's own",
        })
      }
      return FEED.getTimeline.$output.schema.parse(
        await getTimeline({
          viewer: auth.viewer,
          limit: query.limit ?? 30,
          cursor: query.cursor,
        })
      )
    },
    { query: t.Object({ limit: limit(100), cursor }) }
  )
  .get(
    `/xrpc/${FEED.getFeedGenerator.$lxm}`,
    async ({ query, headers }) => {
      const auth = await resolveViewer(
        headers.authorization,
        FEED.getFeedGenerator.$lxm
      )
      if (!("viewer" in auth)) return status(401, auth)
      const gen = await loadGenerator(query.feed)
      const [view] = gen ? await toGeneratorViews([gen], auth.viewer) : []
      if (!view) {
        return status(400, {
          error: "UnknownFeed",
          message: `Unknown feed: ${query.feed}`,
        })
      }
      return FEED.getFeedGenerator.$output.schema.parse({ view })
    },
    { query: t.Object({ feed: atUri }) }
  )
  .get(
    `/xrpc/${FEED.listFeedGenerators.$lxm}`,
    async ({ query, headers }) => {
      const auth = await resolveViewer(
        headers.authorization,
        FEED.listFeedGenerators.$lxm
      )
      if (!("viewer" in auth)) return status(401, auth)
      return FEED.listFeedGenerators.$output.schema.parse(
        await listGenerators({
          limit: query.limit ?? 50,
          cursor: query.cursor,
          viewer: auth.viewer,
        })
      )
    },
    { query: t.Object({ limit: limit(100), cursor }) }
  )
  .get(`/xrpc/${FEED.getPinnedFeeds.$lxm}`, async ({ headers }) => {
    const auth = await verifyServiceAuth(
      headers.authorization,
      FEED.getPinnedFeeds.$lxm
    )
    if (!("did" in auth)) return status(401, auth)
    return FEED.getPinnedFeeds.$output.schema.parse({
      feeds: await getPinned(auth.did),
    })
  })
  .post(
    `/xrpc/${FEED.putPinnedFeeds.$lxm}`,
    async ({ body, headers }) => {
      const auth = await verifyServiceAuth(
        headers.authorization,
        FEED.putPinnedFeeds.$lxm
      )
      if (!("did" in auth)) return status(401, auth)
      const result = await putPinned(auth.did, body.feeds)
      if ("error" in result) return status(400, result)
      return FEED.putPinnedFeeds.$output.schema.parse(result)
    },
    { body: t.Object({ feeds: t.Array(atUri, { maxItems: 50 }) }) }
  )
