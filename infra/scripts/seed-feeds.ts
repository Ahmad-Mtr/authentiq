/**
 * Seeds feed composition (phase 8):
 *
 * - a dedicated publisher account, `authentiq-feeds.test`, whose repo holds the
 *   first-party `sh.authentiq.feed.generator` records. Each names the feed
 *   generator service (`did:web:localhost%3A2585`, from apps/feedgen/.env);
 * - a few more follows, so alice.test's `following` feed has several people
 *   in it (seed:social gave her two);
 * - pins for alice.test: `following` and `jobs-for-you`.
 *
 * Records are written to the PDS, like every other seed, and travel the real
 * path (firehose → indexer → rules → Postgres). Pins are the exception by
 * design: they are private AppView state, so they are set through the
 * AppView's `putPinnedFeeds` with a service auth token alice's PDS signs.
 *
 * Idempotent: record keys are fixed (the feed names, deterministic TIDs for
 * follows), `createdAt` is fixed, and a record already in place is not
 * written again. Then it waits (polling, with a timeout) for the index and
 * checks the record → DID → endpoint chain through the AppView.
 *
 *   bun run seed:feeds
 */
import { join } from "node:path"
import { SQL } from "bun"
import { LOCAL_NETWORK, isValidTid } from "@workspace/atproto"
import { sh } from "@workspace/lexicons"

const root = join(import.meta.dir, "..", "..")
const readEnv = async (path: string) =>
  Object.fromEntries(
    (await Bun.file(join(root, path)).text())
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  )
const infraEnv = await readEnv("infra/.env")
const appviewEnv = await readEnv("apps/appview/.env")
const feedgenEnv = await readEnv("apps/feedgen/.env")

const PDS = process.env.PDS_URL ?? LOCAL_NETWORK.pdsUrl
const APPVIEW = process.env.APPVIEW_URL ?? LOCAL_NETWORK.appviewUrl
const APPVIEW_DID = appviewEnv.SERVICE_DID ?? "did:web:localhost%3A2584"
const FEEDGEN_DID = feedgenEnv.SERVICE_DID ?? "did:web:localhost%3A2585"
const PUBLISHER = feedgenEnv.PUBLISHER ?? "authentiq-feeds.test"
const PASSWORD = "password"
const WAIT_MS = 60_000

const GENERATOR = sh.authentiq.feed.generator
const FOLLOW = sh.authentiq.graph.follow

/** The first-party feeds. The record key is the feed's name at the generator. */
const FEEDS = [
  {
    rkey: "following",
    displayName: "Following",
    description:
      "Posts and replies from the people you follow, newest first. Nothing else, in no other order.",
  },
  {
    rkey: "my-communities",
    displayName: "My communities",
    description:
      "New threads in every community you belong to, newest first, from their current members.",
  },
  {
    rkey: "jobs-for-you",
    displayName: "Jobs for you",
    description:
      "Open job postings closest to your public profile, best match first. Every one states its salary. No scores are shown, to you or anyone.",
  },
  {
    rkey: "industry-pulse",
    displayName: "Industry pulse",
    description:
      "What people in your line of work have written in the last 90 days, newest first: the 25 profiles nearest yours. Signed out: recent community threads. Never ranked by likes.",
  },
]

/** Extra follows, so `following` is more than two people. */
const FOLLOWS = [
  { by: "alice.test", subject: "bob.test" },
  { by: "alice.test", subject: "tal-075.test" },
  { by: "alice.test", subject: "layla.test" },
  { by: "bob.test", subject: "tal-030.test" },
]

const PINS = { handle: "alice.test", feeds: ["following", "jobs-for-you"] }

// --- deterministic keys and timestamps -------------------------------------------

const B32 = "234567abcdefghijklmnopqrstuvwxyz"
function tid(micros: bigint) {
  let v = micros << 10n
  let s = ""
  for (let i = 0; i < 13; i++) {
    s = B32[Number(v & 31n)] + s
    v >>= 5n
  }
  if (!isValidTid(s)) throw new Error(`bad tid ${s}`)
  return s
}
/** Step i happened 17 minutes after step i − 1, starting 2026-09-25 09:00 UTC. */
const BASE_MS = Date.parse("2026-09-25T09:00:00.000Z")
const at = (i: number) => {
  const ms = BASE_MS + i * 17 * 60 * 1000
  return { rkey: tid(BigInt(ms) * 1000n), createdAt: new Date(ms).toISOString() }
}

// --- PDS access ---------------------------------------------------------------------

type Session = { did: string; jwt: string }
const sessions = new Map<string, Session>()

async function xrpc(
  base: string,
  method: string,
  opts: { body?: unknown; params?: Record<string, string>; auth?: string } = {}
) {
  const url = new URL(`/xrpc/${method}`, base)
  for (const [k, v] of Object.entries(opts.params ?? {}))
    url.searchParams.set(k, v)
  const res = await fetch(url, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return {
    ok: res.ok,
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, any>,
  }
}

async function session(handle: string): Promise<Session> {
  const cached = sessions.get(handle)
  if (cached) return cached
  const res = await xrpc(PDS, "com.atproto.server.createSession", {
    body: { identifier: handle, password: PASSWORD },
  })
  if (!res.ok) {
    throw new Error(
      `${handle}: ${res.body.message ?? res.body.error} — run \`bun run seed\`, \`seed:talent\` and \`seed:social\` first`
    )
  }
  const s = { did: res.body.did as string, jwt: `Bearer ${res.body.accessJwt}` }
  sessions.set(handle, s)
  return s
}

/** The publisher account: created on first run, like `bun run seed` does. */
async function ensurePublisher() {
  const existing = await xrpc(PDS, "com.atproto.identity.resolveHandle", {
    params: { handle: PUBLISHER },
  })
  if (existing.ok) return { did: existing.body.did as string, created: false }
  const name = PUBLISHER.replace(/\.test$/, "")
  const res = await xrpc(PDS, "com.atproto.server.createAccount", {
    body: { handle: PUBLISHER, email: `${name}@authentiq.test`, password: PASSWORD },
  })
  if (!res.ok) throw new Error(`createAccount ${PUBLISHER}: ${res.body.message}`)
  return { did: res.body.did as string, created: true }
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x
  )

let written = 0
let unchanged = 0

/** Makes `collection/rkey` in `handle`'s repo equal `record` (putRecord: generators are editable). */
async function ensure(
  handle: string,
  collection: string,
  rkey: string,
  record: Record<string, unknown>
) {
  const s = await session(handle)
  const existing = await xrpc(PDS, "com.atproto.repo.getRecord", {
    params: { repo: s.did, collection, rkey },
  })
  if (existing.ok && canonical(existing.body.value) === canonical(record)) {
    unchanged++
    return existing.body.uri as string
  }
  const res = await xrpc(PDS, "com.atproto.repo.putRecord", {
    body: { repo: s.did, collection, rkey, record },
    auth: s.jwt,
  })
  if (!res.ok) throw new Error(`${handle} ${collection}: ${res.body.message}`)
  written++
  return res.body.uri as string
}

// --- run ------------------------------------------------------------------------

const publisher = await ensurePublisher()
console.log(
  `✓ publisher ${PUBLISHER} ${publisher.did}${publisher.created ? " (created)" : ""}`
)

const feedUris: Record<string, string> = {}
for (const [i, feed] of FEEDS.entries()) {
  feedUris[feed.rkey] = await ensure(
    PUBLISHER,
    GENERATOR.$nsid,
    feed.rkey,
    GENERATOR.$parse({
      $type: GENERATOR.$type,
      did: FEEDGEN_DID,
      displayName: feed.displayName,
      description: feed.description,
      createdAt: at(i).createdAt,
    })
  )
}
const followUris: Array<string> = []
for (const [i, f] of FOLLOWS.entries()) {
  const { rkey, createdAt } = at(FEEDS.length + i)
  followUris.push(
    await ensure(
      f.by,
      FOLLOW.$nsid,
      rkey,
      FOLLOW.$parse({
        $type: FOLLOW.$type,
        subject: (await session(f.subject)).did,
        createdAt,
      })
    )
  )
}
console.log(
  `✓ ${FEEDS.length + FOLLOWS.length} records: ${written} written, ${unchanged} already up to date`
)

// --- wait for the index -------------------------------------------------------

const db = new SQL(
  `postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`
)
const count = async (table: string, uris: Array<string>) =>
  (
    await db.unsafe(
      `select count(*)::int as n from ${table} where uri in (${uris.map((_, i) => `$${i + 1}`).join(", ")})`,
      uris
    )
  )[0].n as number

const started = performance.now()
for (;;) {
  const gens = await count("feed_generator", Object.values(feedUris))
  const follows = await count("follow", followUris)
  if (gens === FEEDS.length && follows === FOLLOWS.length) {
    console.log(
      `✓ indexed: ${gens}/${FEEDS.length} generators, ${follows}/${FOLLOWS.length} follows (${Math.round(performance.now() - started)} ms)`
    )
    break
  }
  if (performance.now() - started > WAIT_MS) {
    console.log(
      `✗ timed out after ${WAIT_MS / 1000} s (${gens} generators, ${follows} follows) — is the AppView running (bun run dev)?`
    )
    await db.close()
    process.exit(1)
  }
  await Bun.sleep(250)
}
await db.close()

// --- pins: private AppView state, set with alice's own service auth -------------

const alice = await session(PINS.handle)
const token = async (aud: string, lxm: string) => {
  const res = await xrpc(PDS, "com.atproto.server.getServiceAuth", {
    params: { aud, lxm, exp: String(Math.floor(Date.now() / 1000) + 60) },
    auth: alice.jwt,
  })
  if (!res.ok) throw new Error(`getServiceAuth: ${res.body.message}`)
  return `Bearer ${res.body.token}`
}
const pinned = PINS.feeds.map((k) => feedUris[k]!)
const put = await xrpc(APPVIEW, sh.authentiq.feed.putPinnedFeeds.$lxm, {
  body: { feeds: pinned },
  auth: await token(APPVIEW_DID, sh.authentiq.feed.putPinnedFeeds.$lxm),
})
if (!put.ok) {
  console.log(`✗ pinning for ${PINS.handle}: ${put.status} ${put.body.message}`)
  process.exit(1)
}
console.log(`✓ ${PINS.handle} pinned ${PINS.feeds.join(", ")}`)

// --- the chain: generator record → DID document → endpoint → skeleton → hydrate ---

const following = await xrpc(APPVIEW, sh.authentiq.feed.getFeed.$lxm, {
  params: { feed: feedUris.following!, limit: "50" },
  auth: await token(FEEDGEN_DID, sh.authentiq.feed.getFeedSkeleton.$lxm),
})
if (!following.ok) {
  console.log(
    `✗ getFeed(following) as ${PINS.handle}: ${following.status} ${following.body.error} ${following.body.message ?? ""} — is the feedgen running?`
  )
  process.exit(1)
}
const authors = new Set(
  (following.body.feed as Array<any>).map((i) => i.post?.author?.handle)
)
console.log(
  `✓ getFeed(following) for ${PINS.handle}: ${following.body.feed.length} posts by ${[...authors].sort().join(", ")}`
)
