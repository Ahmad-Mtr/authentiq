import type { Facet } from "./richtext.ts"

/**
 * What the social pages render (phase 6). Plain, serializable shapes mapped
 * from the AppView's lexicon views on the server (server/social.ts). The
 * lexicon types themselves carry open unions and `unknown` records, which
 * server functions cannot type as serializable.
 *
 * Note what is absent: no like count, no follower count, no member count.
 */

export type ActorUI = {
  did: string
  handle: string
  displayName?: string
  headline?: string
}

export type PostUI = {
  uri: string
  cid: string
  author: ActorUI
  text: string
  facets: Array<Facet>
  createdAt: string
  reply?: { root: string; parent: string }
  link?: { uri: string; title: string; description?: string }
  community?: { uri: string; name: string; topic: string }
  replyCount: number
  /** The viewer's like record, if they liked it. */
  like?: string
}

export type PlaceholderUI =
  | { kind: "notFound"; uri: string }
  | { kind: "hidden"; uri: string; community?: string }

export type ThreadUI =
  | { kind: "post"; post: PostUI; parent?: ThreadUI; replies: Array<ThreadUI> }
  | (PlaceholderUI & { replies: Array<ThreadUI> })

export type FeedItemUI = {
  post: PostUI
  replyTo?: { kind: "post"; post: PostUI } | PlaceholderUI
}

export type CommunityUI = {
  uri: string
  cid: string
  creator: ActorUI
  name: string
  topic: string
  description?: string
  rules: Array<string>
  createdAt: string
  membership?: string
  isCreator: boolean
}
