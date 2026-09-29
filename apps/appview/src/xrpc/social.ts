import { Elysia, status, t } from "elysia"
import { sh } from "@workspace/lexicons"
import { resolveViewer, verifyServiceAuth } from "../auth.ts"
import {
  getCommunity,
  listCommunities,
  setHidden,
} from "../social/communities.ts"
import {
  getAuthorFeed,
  getCommunityPosts,
  loadCommunity,
  resolveActor,
} from "../social/feeds.ts"
import { getPostThread } from "../social/thread.ts"

/**
 * Phase 6 queries and the community moderation procedures.
 *
 * Queries are public, like getProfile, and take optional service auth for
 * their own method to add viewer state. Responses are parsed through the
 * generated output schemas, which is also what keeps them free of counts
 * the lexicons do not define.
 */

const FEED = sh.authentiq.feed
const COMMUNITY = sh.authentiq.community

const atUri = t.String({ pattern: "^at://", maxLength: 8192 })
const limit = (max: number) =>
  t.Optional(t.Numeric({ minimum: 1, maximum: max }))

export const socialRoutes = new Elysia()
  .get(
    `/xrpc/${FEED.getPostThread.$lxm}`,
    async ({ query, headers }) => {
      const auth = await resolveViewer(
        headers.authorization,
        FEED.getPostThread.$lxm
      )
      if (!("viewer" in auth)) return status(401, auth)
      const thread = await getPostThread({
        uri: query.uri,
        depth: query.depth ?? 8,
        parentHeight: query.parentHeight ?? 80,
        viewer: auth.viewer,
      })
      if (!thread) {
        return status(400, {
          error: "NotFound",
          message: `Post not found: ${query.uri}`,
        })
      }
      return FEED.getPostThread.$output.schema.parse({ thread })
    },
    {
      query: t.Object({
        uri: atUri,
        depth: t.Optional(t.Numeric({ minimum: 0, maximum: 20 })),
        parentHeight: t.Optional(t.Numeric({ minimum: 0, maximum: 100 })),
      }),
    }
  )
  .get(
    `/xrpc/${FEED.getAuthorFeed.$lxm}`,
    async ({ query, headers }) => {
      const auth = await resolveViewer(
        headers.authorization,
        FEED.getAuthorFeed.$lxm
      )
      if (!("viewer" in auth)) return status(401, auth)
      const did = await resolveActor(query.actor)
      if (!did) {
        return status(400, {
          error: "ActorNotFound",
          message: `Unknown actor: ${query.actor}`,
        })
      }
      return FEED.getAuthorFeed.$output.schema.parse(
        await getAuthorFeed({
          did,
          limit: query.limit ?? 30,
          cursor: query.cursor,
          viewer: auth.viewer,
        })
      )
    },
    {
      query: t.Object({
        actor: t.String({ maxLength: 2048 }),
        limit: limit(100),
        cursor: t.Optional(t.String({ maxLength: 200 })),
      }),
    }
  )
  .get(
    `/xrpc/${COMMUNITY.list.$lxm}`,
    async ({ query, headers }) => {
      const auth = await resolveViewer(
        headers.authorization,
        COMMUNITY.list.$lxm
      )
      if (!("viewer" in auth)) return status(401, auth)
      return COMMUNITY.list.$output.schema.parse(
        await listCommunities({
          topic: query.topic,
          limit: query.limit ?? 50,
          cursor: query.cursor,
          viewer: auth.viewer,
        })
      )
    },
    {
      query: t.Object({
        topic: t.Optional(t.String({ maxLength: 640 })),
        limit: limit(100),
        cursor: t.Optional(t.String({ maxLength: 200 })),
      }),
    }
  )
  .get(
    `/xrpc/${COMMUNITY.getCommunity.$lxm}`,
    async ({ query, headers }) => {
      const auth = await resolveViewer(
        headers.authorization,
        COMMUNITY.getCommunity.$lxm
      )
      if (!("viewer" in auth)) return status(401, auth)
      const view = await getCommunity(query.uri, auth.viewer)
      return (
        view ??
        status(400, {
          error: "CommunityNotFound",
          message: `Unknown community: ${query.uri}`,
        })
      )
    },
    { query: t.Object({ uri: atUri }) }
  )
  .get(
    `/xrpc/${COMMUNITY.getPosts.$lxm}`,
    async ({ query, headers }) => {
      const auth = await resolveViewer(
        headers.authorization,
        COMMUNITY.getPosts.$lxm
      )
      if (!("viewer" in auth)) return status(401, auth)
      const community = await loadCommunity(query.community)
      if (!community) {
        return status(400, {
          error: "CommunityNotFound",
          message: `Unknown community: ${query.community}`,
        })
      }
      return COMMUNITY.getPosts.$output.schema.parse(
        await getCommunityPosts({
          community,
          limit: query.limit ?? 30,
          cursor: query.cursor,
          viewer: auth.viewer,
        })
      )
    },
    {
      query: t.Object({
        community: atUri,
        limit: limit(100),
        cursor: t.Optional(t.String({ maxLength: 200 })),
      }),
    }
  )
  .post(
    `/xrpc/${COMMUNITY.hidePost.$lxm}`,
    ({ body, headers }) => hide(headers.authorization, body, true),
    { body: t.Object({ community: atUri, post: atUri }) }
  )
  .post(
    `/xrpc/${COMMUNITY.unhidePost.$lxm}`,
    ({ body, headers }) => hide(headers.authorization, body, false),
    { body: t.Object({ community: atUri, post: atUri }) }
  )

/** Service auth is required, for the exact method; the caller is its issuer. */
async function hide(
  authorization: string | undefined,
  body: { community: string; post: string },
  hidden: boolean
) {
  const lxm = hidden ? COMMUNITY.hidePost.$lxm : COMMUNITY.unhidePost.$lxm
  const auth = await verifyServiceAuth(authorization, lxm)
  if (!("did" in auth)) return status(401, auth)
  const result = await setHidden({ caller: auth.did, ...body, hidden })
  if ("ok" in result) return { hidden: result.hidden }
  return status(result.status, {
    error: result.error,
    message: result.message,
  })
}
