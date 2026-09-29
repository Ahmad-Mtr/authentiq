import { createServerFn } from "@tanstack/react-start"
import { sh } from "@workspace/lexicons"
import { z } from "zod"
import { getSessionAgent } from "./session.ts"
import { queryAppView, toCommunity, toFeed, toThread } from "./social.ts"

/**
 * Server functions for the social pages' loaders. This module exports only
 * server functions, so route components can import it without pulling the
 * BFF (session, Postgres driver) into the browser bundle: see the phase 4
 * client-bundle regression. Every read goes to the AppView, with the
 * viewer's service auth when someone is signed in.
 */

const FEED = sh.authentiq.feed
const COMMUNITY = sh.authentiq.community

type Json = Record<string, any>
const atUri = z.string().regex(/^at:\/\/[^/]+\/[^/]+\/[^/]+$/)

export const getAuthorFeed = createServerFn()
  .validator(z.object({ actor: z.string().max(2048) }))
  .handler(async ({ data }) => {
    const res = await queryAppView<{ feed: Array<Json> }>(
      await getSessionAgent(),
      FEED.getAuthorFeed.$lxm,
      { actor: data.actor, limit: 50 }
    )
    return res.ok ? toFeed(res.data.feed) : []
  })

export const getThread = createServerFn()
  .validator(z.object({ uri: atUri }))
  .handler(async ({ data }) => {
    const agent = await getSessionAgent()
    const res = await queryAppView<{ thread: Json }>(
      agent,
      FEED.getPostThread.$lxm,
      { uri: data.uri }
    )
    return {
      thread: res.ok ? toThread(res.data.thread) : null,
      viewer: agent?.did ?? null,
    }
  })

export const getCommunities = createServerFn().handler(async () => {
  const agent = await getSessionAgent()
  const res = await queryAppView<{ communities: Array<Json> }>(
    agent,
    COMMUNITY.list.$lxm,
    { limit: 100 }
  )
  return {
    communities: res.ok ? res.data.communities.map(toCommunity) : [],
    viewer: agent?.did ?? null,
  }
})

export const getCommunityPage = createServerFn()
  .validator(z.object({ uri: atUri }))
  .handler(async ({ data }) => {
    const agent = await getSessionAgent()
    const [community, posts] = await Promise.all([
      queryAppView<Json>(agent, COMMUNITY.getCommunity.$lxm, { uri: data.uri }),
      queryAppView<{ feed: Array<Json> }>(agent, COMMUNITY.getPosts.$lxm, {
        community: data.uri,
        limit: 50,
      }),
    ])
    if (!community.ok) return null
    return {
      community: toCommunity(community.data),
      feed: posts.ok ? toFeed(posts.data.feed) : [],
      viewer: agent?.did ?? null,
    }
  })
