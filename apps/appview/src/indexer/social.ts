import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { defineCollection } from "./collections.ts"
import {
  checkCommunity,
  checkFacets,
  checkFollow,
  checkLikeSubject,
  checkMembership,
  checkPostText,
  checkReply,
  isHttpUri,
} from "./rules.ts"

/**
 * Phase 6 collections: posts, likes, follows, communities and memberships.
 *
 * Nothing here looks at other rows. A reply may be indexed before its parent,
 * a like before its post, a community post before its author's membership,
 * so every record that is valid on its own is indexed, and relationships are
 * resolved when views are built (apps/appview/src/social).
 */

/** Feed order never trusts a createdAt in the future. */
const sortAt = (createdAt: string) =>
  new Date(Math.min(Date.parse(createdAt), Date.now()))

export const post = defineCollection({
  schema: sh.authentiq.feed.post,
  table: schema.post,
  immutable: true,
  rules: (v, at) =>
    checkPostText(v.text) ??
    checkFacets(v.text, v.facets) ??
    checkReply(v.reply, v.community, at.uri) ??
    (v.embed?.$type === sh.authentiq.embed.external.$type &&
    !isHttpUri((v.embed as sh.authentiq.embed.external.Main).external.uri)
      ? "link card URI is not http(s)"
      : undefined),
  toRow: (v) => ({
    text: v.text,
    facets: v.facets ?? null,
    replyRootUri: v.reply?.root.uri,
    replyRootCid: v.reply?.root.cid,
    replyParentUri: v.reply?.parent.uri,
    replyParentCid: v.reply?.parent.cid,
    communityUri: v.community?.uri,
    communityCid: v.community?.cid,
    // Unknown embed kinds (the union is open) are kept, and ignored by views.
    embed: v.embed ?? null,
    createdAt: new Date(v.createdAt),
    sortAt: sortAt(v.createdAt),
  }),
})

export const like = defineCollection({
  schema: sh.authentiq.feed.like,
  table: schema.postLike,
  rules: (v) => checkLikeSubject(v.subject),
  toRow: (v) => ({
    subjectUri: v.subject.uri,
    subjectCid: v.subject.cid,
    createdAt: new Date(v.createdAt),
  }),
})

export const follow = defineCollection({
  schema: sh.authentiq.graph.follow,
  table: schema.follow,
  rules: (v, at) => checkFollow(v.subject, at.did),
  toRow: (v) => ({ subject: v.subject, createdAt: new Date(v.createdAt) }),
})

export const community = defineCollection({
  schema: sh.authentiq.community.declaration,
  table: schema.community,
  rules: (v) => checkCommunity(v),
  toRow: (v) => ({
    name: v.name,
    description: v.description,
    topic: v.topic,
    rules: v.rules,
    createdAt: new Date(v.createdAt),
    sortAt: sortAt(v.createdAt),
  }),
})

export const membership = defineCollection({
  schema: sh.authentiq.community.membership,
  table: schema.membership,
  rules: (v) => checkMembership(v.community),
  toRow: (v) => ({
    communityUri: v.community.uri,
    communityCid: v.community.cid,
    createdAt: new Date(v.createdAt),
  }),
})
