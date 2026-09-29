import { IdResolver, MemoryCache } from "@atproto/identity"
import { and, eq } from "drizzle-orm"
import { schema } from "@workspace/db"
import { BlockedUrlError } from "@workspace/atproto/fetch-guard"
import { db } from "../db.ts"
import { env } from "../env.ts"
import { guardedFetch } from "../fetch.ts"

/**
 * Feed resolution (phase 8): generator record → DID document → service
 * endpoint.
 *
 * 1. The record comes from the index, so it has passed the lexicon and
 *    `checkFeedGenerator`, and its publisher is active.
 * 2. Its `did` is resolved through PLC or did:web, with the fetch guard. A
 *    did:web on a blocked address is refused before any request is made.
 * 3. The document must have a `#authentiq_fg` service of type
 *    `AuthentiqFeedGenerator` (our namespace's `#bsky_fg`/`BskyFeedGenerator`).
 *    Its endpoint is not checked here but when it is fetched, by the same
 *    guard, so the rules are in one place.
 *
 * DID documents are cached: fresh for 5 minutes, then served while being
 * refreshed, and dropped after an hour. A failed resolution is not cached.
 */

export const FEEDGEN_SERVICE = { id: "#authentiq_fg", type: "AuthentiqFeedGenerator" }

export class FeedError extends Error {
  constructor(
    readonly status: number,
    readonly error: "UnknownFeed" | "FeedUnavailable" | "AuthRequired",
    message: string,
    /** For the log only: never sent to the client. */
    readonly detail?: string
  ) {
    super(message)
  }
}

export type Generator = typeof schema.feedGenerator.$inferSelect

/** A generator record whose publisher is active, or undefined. */
export async function loadGenerator(uri: string) {
  const [row] = await db
    .select({ gen: schema.feedGenerator })
    .from(schema.feedGenerator)
    .innerJoin(schema.actor, eq(schema.actor.did, schema.feedGenerator.did))
    .where(and(eq(schema.feedGenerator.uri, uri), eq(schema.actor.active, true)))
  return row?.gen
}

const MINUTE = 60 * 1000
const feedDids = new IdResolver({
  plcUrl: env.PLC_URL,
  timeout: 3000,
  didCache: new MemoryCache(5 * MINUTE, 60 * MINUTE),
  fetch: guardedFetch,
})

/** The generator service's endpoint, or a FeedError. */
export async function resolveEndpoint(serviceDid: string) {
  let doc
  try {
    doc = await feedDids.did.resolve(serviceDid)
  } catch (err) {
    throw new FeedError(
      502,
      "FeedUnavailable",
      err instanceof BlockedUrlError
        ? "The feed's DID document is at an address this AppView will not contact"
        : "The feed's service could not be resolved",
      `${serviceDid}: ${(err as Error).message}`
    )
  }
  if (!doc) {
    throw new FeedError(
      502,
      "FeedUnavailable",
      "The feed's service could not be resolved",
      `${serviceDid}: no DID document`
    )
  }
  const service = (doc.service ?? []).find(
    (s) =>
      (s.id === FEEDGEN_SERVICE.id || s.id === `${doc.id}${FEEDGEN_SERVICE.id}`) &&
      s.type === FEEDGEN_SERVICE.type
  )
  const endpoint = service?.serviceEndpoint
  if (typeof endpoint !== "string") {
    throw new FeedError(
      502,
      "FeedUnavailable",
      "The feed's service does not declare a feed generator endpoint",
      `${serviceDid}: no ${FEEDGEN_SERVICE.id} service of type ${FEEDGEN_SERVICE.type}`
    )
  }
  return endpoint
}
