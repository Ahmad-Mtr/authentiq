import type { JobUI } from "./job-types.ts"
import type { ActorUI, FeedItemUI } from "./social-types.ts"

/**
 * What the feed pages render (phase 8): plain, serializable shapes mapped on
 * the server (server/feeds.ts) from the AppView's lexicon views.
 */

export type GeneratorUI = {
  uri: string
  /** The feed generator service. */
  did: string
  creator: ActorUI
  displayName: string
  description?: string
  pinned: boolean
}

/** One entry of a hydrated feed. The union is open; unknown kinds are skipped. */
export type FeedEntryUI =
  | ({ kind: "post" } & FeedItemUI)
  | { kind: "job"; job: JobUI }

export type FeedPageUI =
  | { ok: true; entries: Array<FeedEntryUI>; cursor?: string }
  | {
      ok: false
      /** FeedUnavailable, AuthRequired or UnknownFeed, from the AppView. */
      error: string
      message: string
    }

/** Route params for a feed's page, from its generator record's AT-URI. */
export function feedParams(uri: string) {
  const [, , actor, , rkey] = uri.split("/")
  return { actor: actor, rkey: rkey }
}

export const feedUriOf = (actor: string, rkey: string) =>
  `at://${actor}/sh.authentiq.feed.generator/${rkey}`
