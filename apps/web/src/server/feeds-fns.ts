import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  fetchDirectory,
  fetchFeed,
  fetchGenerator,
  fetchPinned,
  fetchTimeline,
} from "./feeds.ts"
import { getSessionAgent } from "./session.ts"

/**
 * Server functions for the feed pages' loaders (phase 8). This module
 * exports only server functions, so route components can import it without
 * pulling the BFF (session, Postgres driver) into the browser bundle: the
 * phase 4 client-bundle lesson.
 */

const feedUri = z
  .string()
  .regex(/^at:\/\/[^/]+\/sh\.authentiq\.feed\.generator\/[^/]+$/)

/**
 * Home, signed in: the pinned feeds for the switcher, and either the
 * timeline or the selected pinned feed. A feed that fails is reported in
 * `page`, and the rest of the page still renders.
 */
export const getHome = createServerFn()
  .validator(z.object({ feed: feedUri.optional() }))
  .handler(async ({ data }) => {
    const agent = await getSessionAgent()
    if (!agent) return null
    const pinned = await fetchPinned(agent).catch(() => [])
    const selected = data.feed
      ? (pinned.find((g) => g.uri === data.feed) ??
        (await fetchGenerator(agent, data.feed)))
      : undefined
    const page = selected
      ? await fetchFeed(agent, { feed: selected.uri, did: selected.did })
      : await fetchTimeline(agent)
    return { viewer: agent.assertDid, pinned, selected: selected ?? null, page }
  })

export const getFeedPage = createServerFn()
  .validator(z.object({ uri: feedUri }))
  .handler(async ({ data }) => {
    const agent = await getSessionAgent()
    const generator = await fetchGenerator(agent, data.uri)
    if (!generator) return null
    return {
      generator,
      page: await fetchFeed(agent, { feed: generator.uri, did: generator.did }),
      viewer: agent?.did ?? null,
    }
  })

export const getFeedDirectory = createServerFn().handler(async () => {
  const agent = await getSessionAgent()
  return { feeds: await fetchDirectory(agent), viewer: agent?.did ?? null }
})
