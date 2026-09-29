import * as actor from "./actor.ts"
import type { CollectionHandler } from "./collections.ts"

/**
 * Every collection the indexer understands, by NSID. Records in other
 * `sh.authentiq.*` collections (lexicons from later phases) are ignored until
 * a handler is registered here.
 */
export const collections: ReadonlyMap<string, CollectionHandler> = new Map(
  [actor.profile, actor.position, actor.education].map((h) => [h.collection, h])
)
