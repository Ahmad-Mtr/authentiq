import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { db } from "../db.ts"
import { loadProfileViews } from "../social/hydrate.ts"
import type { Generator } from "./resolve.ts"

/**
 * Feed declarations as views, discovery and pins (phase 8). Nothing here
 * contacts a feed generator: a view is the indexed record, and whether the
 * service answers is only known when the feed is read.
 */

const FEED = sh.authentiq.feed
type GeneratorView = sh.authentiq.feed.defs.GeneratorView

export const MAX_PINS = 10

/** The viewer's pinned feed URIs, in order. */
export async function pinsOf(viewer: string) {
  const [row] = await db
    .select({ feeds: schema.feedPin.feeds })
    .from(schema.feedPin)
    .where(eq(schema.feedPin.did, viewer))
  return row?.feeds ?? []
}

/** Views for generator rows, in order. Rows whose publisher is inactive are left out. */
export async function toGeneratorViews(
  rows: Array<Generator>,
  viewer: string | undefined
): Promise<Array<GeneratorView>> {
  const [creators, pins] = await Promise.all([
    loadProfileViews(rows.map((r) => r.did)),
    viewer ? pinsOf(viewer) : [],
  ])
  const pinned = new Set(pins)
  return rows.flatMap((r) => {
    const creator = creators.get(r.did)
    if (!creator) return []
    return [
      FEED.defs.generatorView.parse({
        uri: r.uri,
        cid: r.cid,
        did: r.serviceDid,
        creator,
        displayName: r.displayName,
        description: r.description ?? undefined,
        indexedAt: r.indexedAt.toISOString(),
        viewer: viewer ? { pinned: pinned.has(r.uri) } : undefined,
      }),
    ]
  })
}

/** Generator rows by URI whose publishers are active, in the order given. */
async function loadGenerators(uris: Array<string>) {
  if (uris.length === 0) return []
  const rows = await db
    .select({ gen: schema.feedGenerator })
    .from(schema.feedGenerator)
    .innerJoin(schema.actor, eq(schema.actor.did, schema.feedGenerator.did))
    .where(
      and(inArray(schema.feedGenerator.uri, uris), eq(schema.actor.active, true))
    )
  const byUri = new Map(rows.map((r) => [r.gen.uri, r.gen]))
  return uris.flatMap((u) => {
    const g = byUri.get(u)
    return g ? [g] : []
  })
}

/**
 * sh.authentiq.feed.listFeedGenerators: every generator, oldest first. No
 * popularity order: nothing is counted, so nothing can be ranked by it.
 */
export async function listGenerators(opts: {
  limit: number
  cursor?: string
  viewer: string | undefined
}) {
  const g = schema.feedGenerator
  const after = decodeCursor(opts.cursor)
  const rows = await db
    .select({ gen: g })
    .from(g)
    .innerJoin(schema.actor, eq(schema.actor.did, g.did))
    .where(
      and(
        eq(schema.actor.active, true),
        after
          ? sql`(${g.sortAt}, ${g.uri}) > (${after.sortAt.toISOString()}::timestamptz, ${after.uri})`
          : undefined
      )
    )
    .orderBy(asc(g.sortAt), asc(g.uri))
    .limit(opts.limit)
  const gens = rows.map((r) => r.gen)
  const last = gens.at(-1)
  return {
    feeds: await toGeneratorViews(gens, opts.viewer),
    cursor:
      gens.length === opts.limit && last
        ? `${last.sortAt.getTime()}::${last.uri}`
        : undefined,
  }
}

function decodeCursor(value: string | undefined) {
  if (!value) return undefined
  const i = value.indexOf("::")
  const ms = Number(value.slice(0, i))
  if (i < 0 || !Number.isFinite(ms)) return undefined
  return { sortAt: new Date(ms), uri: value.slice(i + 2) }
}

/** sh.authentiq.feed.getPinnedFeeds: pins whose generator still exists, in order. */
export async function getPinned(viewer: string) {
  return toGeneratorViews(await loadGenerators(await pinsOf(viewer)), viewer)
}

/**
 * sh.authentiq.feed.putPinnedFeeds: replaces the list. Every URI must be an
 * indexed generator; repeats keep their first position.
 */
export async function putPinned(viewer: string, feeds: Array<string>) {
  const wanted = [...new Set(feeds)]
  if (wanted.length > MAX_PINS) {
    return { error: "InvalidRequest", message: `At most ${MAX_PINS} pinned feeds` }
  }
  const known = new Set((await loadGenerators(wanted)).map((g) => g.uri))
  const unknown = wanted.find((u) => !known.has(u))
  if (unknown) return { error: "UnknownFeed", message: `Unknown feed: ${unknown}` }
  await db
    .insert(schema.feedPin)
    .values({ did: viewer, feeds: wanted })
    .onConflictDoUpdate({
      target: schema.feedPin.did,
      set: { feeds: wanted, updatedAt: new Date() },
    })
  return { feeds: wanted }
}
