import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { defineCollection } from "./collections.ts"
import { checkFeedGenerator } from "./rules.ts"

/**
 * Phase 8: `sh.authentiq.feed.generator`. The record's AT-URI is the feed's
 * identity; `did` names the service that builds its skeletons. Anyone can
 * publish one, so nothing here trusts `did` beyond its syntax: resolving it
 * and fetching from it happen when the feed is read (src/feeds), through
 * the fetch guard.
 */

/** Discovery order never trusts a createdAt in the future. */
const sortAt = (createdAt: string) =>
  new Date(Math.min(Date.parse(createdAt), Date.now()))

export const generator = defineCollection({
  schema: sh.authentiq.feed.generator,
  table: schema.feedGenerator,
  rules: (v) => checkFeedGenerator(v),
  toRow: (v) => ({
    serviceDid: v.did,
    displayName: v.displayName,
    description: v.description,
    createdAt: new Date(v.createdAt),
    sortAt: sortAt(v.createdAt),
  }),
})
