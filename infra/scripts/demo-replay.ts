/**
 * Replayability demo: the AppView is a derived index (ADR 0001). This wipes
 * everything it holds, rebuilds it from the users' repos alone, and diffs
 * what the product shows before and after.
 *
 *   1. set a moderation label (a community creator hides a post), so there
 *      is AppView-only state to lose
 *   2. snapshot: every profile, every thread, every community's posts, the
 *      job board, the feed directory; and the AppView's private state
 *   3. stop the indexer and empty every AppView table (index, embeddings,
 *      hide labels, pins, resume drafts, the firehose cursor). The web
 *      app's own sessions are left alone: they are the BFF's, not the index
 *   4. start the indexer: with no cursor it re-reads every repo on the PDS
 *   5. diff the snapshots, and list what did not come back
 *
 * The comparison ignores `indexedAt`, which is when this AppView saw a
 * record, not something the repo says. Re-embedding costs money, measured
 * from /_admin/usage. Afterwards, `bun run seed:feeds` restores alice's pins.
 *
 *   bun run demo:replay        (needs bun run dev, the seeds and ADMIN_TOKEN)
 */
import { join } from "node:path"
import { SQL } from "bun"
import { LOCAL_NETWORK } from "@workspace/atproto"

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
const PDS = process.env.PDS_URL ?? LOCAL_NETWORK.pdsUrl
const APPVIEW = process.env.APPVIEW_URL ?? LOCAL_NETWORK.appviewUrl
const APPVIEW_DID = appviewEnv.SERVICE_DID ?? "did:web:localhost%3A2584"
const ADMIN = `Bearer ${appviewEnv.ADMIN_TOKEN}`
if (!appviewEnv.ADMIN_TOKEN) {
  console.log("✗ ADMIN_TOKEN is not set in apps/appview/.env")
  process.exit(1)
}
const db = new SQL(`postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`)

let failures = 0
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
}
const step = (title: string) => console.log(`\n${title}`)

async function xrpc(method: string, opts: { params?: Record<string, string>; body?: unknown; auth?: string; base?: string } = {}) {
  const url = new URL(`/xrpc/${method}`, opts.base ?? APPVIEW)
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v)
  const res = await fetch(url, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return { ok: res.ok, body: (await res.json().catch(() => ({}))) as Record<string, any> }
}
const admin = async (path: string, post = false) =>
  (await fetch(`${APPVIEW}/_admin/${path}`, { method: post ? "POST" : "GET", headers: { authorization: ADMIN } })).json() as Promise<any>

/** JSON with every `indexedAt` removed and keys sorted, for comparison. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (key, x: unknown) =>
    key === "indexedAt"
      ? undefined
      : x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
        : x
  )

async function paged(method: string, key: string, params: Record<string, string> = {}) {
  const out: Array<unknown> = []
  let cursor: string | undefined
  for (let i = 0; i < 100; i++) {
    const r = await xrpc(method, { params: { ...params, limit: "100", ...(cursor ? { cursor } : {}) } })
    out.push(...((r.body[key] ?? []) as Array<unknown>))
    cursor = r.body.cursor
    if (!cursor) break
  }
  return out
}

/** Everything the product shows, from public queries, keyed for diffing. */
async function snapshot() {
  const profiles = new Map<string, string>()
  for (const { did } of await db`select did from profile order by did`) {
    profiles.set(did, stable((await xrpc("sh.authentiq.actor.getProfile", { params: { actor: did } })).body))
  }
  const threads = new Map<string, string>()
  for (const { uri } of await db`select uri from post where reply_root_uri is null order by uri`) {
    threads.set(uri, stable((await xrpc("sh.authentiq.feed.getPostThread", { params: { uri } })).body))
  }
  const communities = new Map<string, string>()
  for (const { uri } of await db`select uri from community order by uri`) {
    communities.set(uri, stable(await paged("sh.authentiq.community.getPosts", "feed", { community: uri })))
  }
  const board = stable(await paged("sh.authentiq.job.listPostings", "postings"))
  const feeds = stable(await paged("sh.authentiq.feed.listFeedGenerators", "feeds"))
  return { profiles, threads, communities, board, feeds }
}

async function privateState() {
  const [r] = await db`
    select
      (select count(*)::int from community_hidden_post) as hides,
      (select count(*)::int from feed_pin) as pins,
      (select count(*)::int from resume_draft) as drafts,
      (select count(*)::int from embedding where vector is not null) as vectors,
      (select count(*)::int from web_session) as sessions`
  return r as { hides: number; pins: number; drafts: number; vectors: number; sessions: number }
}

// --- 1. AppView-only state to lose ---------------------------------------------------

step("1. a community creator hides a post: a label only this AppView holds")
const [target] = await db`
  select p.uri as post, c.uri as community, ca.handle as creator
  from post p
  join community c on c.uri = p.community_uri
  join actor ca on ca.did = c.did
  where p.reply_root_uri is null and p.did <> c.did
    and exists (select 1 from membership m where m.community_uri = c.uri and m.did = p.did)
  order by c.sort_at, p.sort_at
  limit 1`
if (!target) {
  console.log("✗ no community post to hide — run the seeds")
  process.exit(1)
}
const login = await xrpc("com.atproto.server.createSession", { base: PDS, body: { identifier: target.creator, password: "password" } })
const token = await xrpc("com.atproto.server.getServiceAuth", {
  base: PDS,
  params: { aud: APPVIEW_DID, lxm: "sh.authentiq.community.hidePost" },
  auth: `Bearer ${login.body.accessJwt}`,
})
const hidden = await xrpc("sh.authentiq.community.hidePost", {
  body: { community: target.community, post: target.post },
  auth: `Bearer ${token.body.token}`,
})
check(hidden.ok, `${target.creator} hid a post in their community`, target.post)

// --- 2. snapshot ----------------------------------------------------------------------

step("2. snapshot what the product shows")
let t0 = performance.now()
const before = await snapshot()
const privBefore = await privateState()
const tables = await db`
  select
    (select count(*)::int from actor) as actors, (select count(*)::int from profile) as profiles,
    (select count(*)::int from post) as posts, (select count(*)::int from job_posting) as postings,
    (select count(*)::int from community) as communities, (select count(*)::int from feed_generator) as generators`
const counts = tables[0] as Record<string, number>
console.log(
  `  ${before.profiles.size} profiles, ${before.threads.size} threads, ${before.communities.size} communities, the job board and the feed directory (${Math.round(performance.now() - t0)} ms)`
)
console.log(
  `  private state: ${privBefore.hides} hide label(s), ${privBefore.pins} pin list(s), ${privBefore.drafts} resume draft(s), ${privBefore.vectors} embeddings`
)
const hiddenBefore = !before.communities.get(target.community)!.includes(target.post)
check(hiddenBefore, "the hidden post is not in its community's posts")

// --- 3. wipe ----------------------------------------------------------------------------

step("3. stop the indexer and empty the AppView")
await admin("indexer/stop", true)
const spentBefore = (await admin("usage")).costUsd as number
await db.unsafe(`truncate actor, profile, position, education, post, post_like, follow, community, membership,
  job_posting, feed_generator, embedding, community_hidden_post, feed_pin, resume_draft, service_state cascade`)
const [empty] = await db`select (select count(*)::int from actor) + (select count(*)::int from post) + (select count(*)::int from embedding) as n`
check(empty.n === 0, "every AppView table is empty, the firehose cursor included")
const gone = await xrpc("sh.authentiq.actor.getProfile", { params: { actor: "alice.test" } })
check(gone.body.error === "ActorNotFound", "alice.test is unknown to the AppView now", gone.body.error)

// --- 4. rebuild ---------------------------------------------------------------------

step("4. start the indexer: no cursor, so it reads every repo on the PDS")
t0 = performance.now()
await admin("indexer/start", true)
for (;;) {
  const [n] = await db`
    select
      (select count(*)::int from profile) as profiles, (select count(*)::int from post) as posts,
      (select count(*)::int from job_posting) as postings, (select count(*)::int from community) as communities,
      (select count(*)::int from feed_generator) as generators`
  if (
    n.profiles >= counts.profiles! && n.posts >= counts.posts! && n.postings >= counts.postings! &&
    n.communities >= counts.communities! && n.generators >= counts.generators!
  )
    break
  if (performance.now() - t0 > 300_000) {
    check(false, "the index was rebuilt within 5 minutes", JSON.stringify(n))
    process.exit(1)
  }
  await Bun.sleep(250)
}
const indexedMs = Math.round(performance.now() - t0)
const [{ vectors: vectorsRightAfter }] = await db`select count(*)::int as vectors from embedding where vector is not null`
check(true, "profiles, posts, postings, communities and feeds are back in the index", `${indexedMs} ms; ${vectorsRightAfter} of ${privBefore.vectors} embeddings so far`)
for (;;) {
  const s = await admin("embedder")
  const [{ vectors }] = await db`select count(*)::int as vectors from embedding where vector is not null`
  if (s.pending === 0 && vectors >= privBefore.vectors) break
  if (performance.now() - t0 > 600_000) break
  await Bun.sleep(500)
}
const embedMs = Math.round(performance.now() - t0)
const spent = ((await admin("usage")).costUsd as number) - spentBefore

// --- 5. diff --------------------------------------------------------------------------

step("5. compare")
const after = await snapshot()
const privAfter = await privateState()
const diffMap = (a: Map<string, string>, b: Map<string, string>, skip?: string) =>
  [...a.keys()].filter((k) => k !== skip && a.get(k) !== b.get(k)).length + [...b.keys()].filter((k) => !a.has(k)).length
check(diffMap(before.profiles, after.profiles) === 0, "every profile is identical", `${after.profiles.size} profiles with positions and education`)
check(diffMap(before.threads, after.threads, target.post) === 0, "every thread is identical", `${after.threads.size} threads`)
check(
  diffMap(before.communities, after.communities, target.community) === 0,
  "every community's posts are identical, except the one with the hide",
  `${after.communities.size} communities`
)
check(before.board === after.board, "the job board is identical, salary-less postings still absent")
check(before.feeds === after.feeds, "the feed directory is identical")

console.log(`\nwhat did not come back, because no repo holds it:`)
const shownAgain = after.communities.get(target.community)!.includes(target.post)
console.log(`  hide labels      ${privBefore.hides} → ${privAfter.hides}   the hidden post is ${shownAgain ? "back in its community" : "still absent"}`)
console.log(`  pinned feeds     ${privBefore.pins} → ${privAfter.pins}   (bun run seed:feeds restores alice's)`)
console.log(`  resume drafts    ${privBefore.drafts} → ${privAfter.drafts}   (30-minute drafts, by design)`)
console.log(
  `  embeddings       ${privBefore.vectors} → ${vectorsRightAfter} when the index was back, ${privAfter.vectors} after ${Math.round(embedMs / 1000)} s of re-embedding, $${spent.toFixed(4)}`
)
console.log(`  web sessions     ${privBefore.sessions} → ${privAfter.sessions}   (not wiped: the web BFF's state, not the index)`)
check(privAfter.hides === 0 && shownAgain, "the hide label is gone and the post is visible again: moderation lives only in this AppView")
await db.close()
console.log(failures ? `\n✗ ${failures} check(s) failed` : `\n✓ everything users wrote came back from their repos; only AppView-private state did not`)
process.exit(failures ? 1 : 0)
