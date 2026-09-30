/**
 * Replays the LLM-generated demo cast (infra/fixtures/demo/, written once by
 * `bun run fixtures:demo`) through the local PDS: 54 people with profiles,
 * positions and education, five communities with threads, likes, follows
 * and 18 job postings, plus alice.test's positions, education, a membership
 * and three follows (hand-written, alice.json). No model is called: seeding
 * is free and the records are the same on every run.
 *
 * Every record is built with the lexicon's $parse and checked against the
 * indexer's rules (dates, post text, communities, salary transparency) and
 * the real-organisation tripwire before it is written. Anything that fails
 * is logged and dropped; a dropped post takes the replies under it along.
 *
 * Timestamps are relative to the day of the first seeding (the newest
 * thread is a day old), so feeds with a time window, like industry-pulse's
 * 90 days, show the demo whenever it was seeded. Record keys are fixed, and
 * a record that matches apart from `createdAt` is left alone, so running it
 * again writes nothing.
 *
 * The demo cast is separate from the eval corpora: its own accounts, none of
 * the tal-NNN people, no change to seed:talent, the resume fixtures or the
 * labelled queries. It is still indexed by the same AppView, so its people
 * are search candidates too: see docs/evals.md for what that does to
 * eval:search.
 *
 *   bun run seed:demo        (needs bun run seed, seed:social and bun run dev)
 */
import { join } from "node:path"
import { SQL } from "bun"
import { LOCAL_NETWORK, isValidTid } from "@workspace/atproto"
import { sh } from "@workspace/lexicons"
import { checkPosting } from "@workspace/rules/posting"
import {
  checkCommunity,
  checkDateRange,
  checkPostText,
} from "../../apps/appview/src/indexer/rules.ts"
import { REAL_ORGS, SEED, prng, shuffle } from "./lib/demo-plan.ts"

const root = join(import.meta.dir, "..", "..")
const FIXTURES = join(root, "infra", "fixtures", "demo")
const infraEnv = Object.fromEntries(
  (await Bun.file(join(root, "infra/.env")).text())
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
)
const PDS = process.env.PDS_URL ?? LOCAL_NETWORK.pdsUrl
const PASSWORD = "password"
const WAIT_MS = 180_000
const HOUR = 3600_000
const DAY = 24 * HOUR

type Person = {
  handle: string
  profile: Record<string, unknown>
  positions: Array<Record<string, unknown>>
  education: Array<Record<string, unknown>>
}
type Thread = {
  author: string
  text: string
  replies: Array<{ author: string; text: string; replyTo: number }>
}
type Community = {
  key: string
  name: string
  topic: string
  creator: string
  members: Array<string>
  description: string
  rules: Array<string>
  threads: Array<Thread>
}
const { people } = (await Bun.file(join(FIXTURES, "people.json")).json()) as { people: Array<Person> }
const { communities } = (await Bun.file(join(FIXTURES, "communities.json")).json()) as { communities: Array<Community> }
const { postings } = (await Bun.file(join(FIXTURES, "postings.json")).json()) as {
  postings: Array<{ key: string; by: string; record: Record<string, unknown> }>
}
const alice = (await Bun.file(join(FIXTURES, "alice.json")).json()) as {
  positions: Array<Record<string, unknown>>
  education: Array<Record<string, unknown>>
  joins: Array<string>
  follows: Array<string>
}

// --- validation ----------------------------------------------------------------------

const dropped: Array<string> = []
function valid(label: string, build: () => unknown, ...checks: Array<string | undefined>) {
  const why = checks.find(Boolean)
  if (why) {
    dropped.push(`${label}: ${why}`)
    return false
  }
  try {
    build()
    return true
  } catch (err) {
    dropped.push(`${label}: ${(err as Error).message}`)
    return false
  }
}
const realOrg = (...texts: Array<unknown>) => {
  const m = texts.filter(Boolean).join(" | ").match(REAL_ORGS)
  return m ? `names a real organisation (“${m[0]}”)` : undefined
}

// --- keys and time ---------------------------------------------------------------------

/** Base32-sortable TID, so record keys never change between runs. */
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
/** Each kind of record gets its own range of keys, from a fixed base. */
const KEY_BASE = BigInt(Date.parse("2026-09-30T00:00:00.000Z")) * 1000n
const keyOf = (kind: number, i: number) => tid(KEY_BASE + BigInt(kind * 100_000 + i))
const KIND = { position: 1, education: 2, community: 3, membership: 4, post: 5, posting: 6, like: 7, follow: 8 }

/** Relative to the first seeding: kept in the repo, so later runs reuse it. */
const now = Date.now()
const at = (msAgo: number) => new Date(Math.min(now - msAgo, now - 60_000)).toISOString()

// --- PDS ---------------------------------------------------------------------------

async function xrpc(method: string, opts: { body?: unknown; params?: Record<string, string>; auth?: string }) {
  const url = new URL(`/xrpc/${method}`, PDS)
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

type Session = { did: string; jwt: string }
const sessions = new Map<string, Session>()
let accountsCreated = 0
async function session(handle: string): Promise<Session> {
  const cached = sessions.get(handle)
  if (cached) return cached
  let res = await xrpc("com.atproto.server.createSession", { body: { identifier: handle, password: PASSWORD } })
  if (!res.ok) {
    res = await xrpc("com.atproto.server.createAccount", {
      body: { handle, email: `${handle.replace(/\.test$/, "")}@authentiq.test`, password: PASSWORD },
    })
    if (!res.ok) throw new Error(`${handle}: ${res.body.message ?? res.body.error}`)
    accountsCreated++
  }
  const s = { did: res.body.did as string, jwt: `Bearer ${res.body.accessJwt}` }
  sessions.set(handle, s)
  return s
}

/** Canonical JSON without createdAt: the time is not part of what a record says. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (key, x: unknown) =>
    key === "createdAt"
      ? undefined
      : x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
        : x
  )

let written = 0
let unchanged = 0
/**
 * Makes `collection/rkey` in `handle`'s repo say `record`. Returns its ref.
 * Posts are create-only in the AppView, so a changed post is replaced, not
 * updated; other records are overwritten with putRecord.
 */
async function ensure(handle: string, collection: string, rkey: string, record: Record<string, unknown>) {
  const s = await session(handle)
  const existing = await xrpc("com.atproto.repo.getRecord", { params: { repo: s.did, collection, rkey } })
  if (existing.ok && canonical(existing.body.value) === canonical(record)) {
    unchanged++
    return { uri: existing.body.uri as string, cid: existing.body.cid as string }
  }
  if (existing.ok && collection === sh.authentiq.feed.post.$nsid) {
    await xrpc("com.atproto.repo.deleteRecord", { body: { repo: s.did, collection, rkey }, auth: s.jwt })
  }
  const res = await xrpc(
    existing.ok && collection !== sh.authentiq.feed.post.$nsid ? "com.atproto.repo.putRecord" : "com.atproto.repo.createRecord",
    { body: { repo: s.did, collection, rkey, record }, auth: s.jwt }
  )
  if (!res.ok) throw new Error(`${handle} ${collection}/${rkey}: ${res.body.message}`)
  written++
  return { uri: res.body.uri as string, cid: res.body.cid as string }
}

async function pool<T>(items: Array<T>, n: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let i = next++; i < items.length; i = next++) await fn(items[i]!, i)
    })
  )
}

// --- people ------------------------------------------------------------------------

const expected = {
  profiles: [] as Array<string>,
  posts: [] as Array<string>,
  postings: [] as Array<string>,
  communities: [] as Array<string>,
}
const P = sh.authentiq.actor

await pool(people, 4, async (p, i) => {
  const profile = { $type: P.profile.$type, ...p.profile, createdAt: at(40 * DAY) }
  if (!valid(`${p.handle} profile`, () => P.profile.$parse(profile), realOrg(p.profile.headline, p.profile.about))) return
  await ensure(p.handle, P.profile.$nsid, "self", P.profile.$parse(profile) as Record<string, unknown>)
  expected.profiles.push((await session(p.handle)).did)
  for (const [j, x] of p.positions.entries()) {
    const record = { $type: P.position.$type, ...x, createdAt: at(40 * DAY) }
    const label = `${p.handle} position “${x.title}”`
    if (!valid(label, () => P.position.$parse(record), checkDateRange(x.startDate as string, x.endDate as string | undefined), realOrg(x.organization, x.description))) continue
    await ensure(p.handle, P.position.$nsid, keyOf(KIND.position, i * 10 + j), P.position.$parse(record) as Record<string, unknown>)
  }
  for (const [j, e] of p.education.entries()) {
    const record = { $type: P.education.$type, ...e, createdAt: at(40 * DAY) }
    const label = `${p.handle} education “${e.school}”`
    if (!valid(label, () => P.education.$parse(record), checkDateRange(e.startDate as string, e.endDate as string), realOrg(e.school))) continue
    await ensure(p.handle, P.education.$nsid, keyOf(KIND.education, i * 10 + j), P.education.$parse(record) as Record<string, unknown>)
  }
})
// alice.test: her profile is phase 2's, from `bun run seed`; positions and education are hand-written.
for (const [j, x] of alice.positions.entries()) {
  const record = P.position.$parse({ $type: P.position.$type, ...x, createdAt: at(40 * DAY) })
  await ensure("alice.test", P.position.$nsid, keyOf(KIND.position, 9000 + j), record as Record<string, unknown>)
}
for (const [j, e] of alice.education.entries()) {
  const record = P.education.$parse({ $type: P.education.$type, ...e, createdAt: at(40 * DAY) })
  await ensure("alice.test", P.education.$nsid, keyOf(KIND.education, 9000 + j), record as Record<string, unknown>)
}
console.log(`✓ ${people.length} people and alice.test's career (${accountsCreated} account(s) created)`)

// --- communities, memberships, threads -----------------------------------------------

const C = sh.authentiq.community
const POST = sh.authentiq.feed.post
const refs = new Map<string, { uri: string; cid: string }>()
const postRefs: Array<{ uri: string; cid: string; members: Array<string> }> = []
let postIndex = 0

for (const [ci, c] of communities.entries()) {
  const decl = { $type: C.declaration.$type, name: c.name, topic: c.topic, description: c.description, rules: c.rules, createdAt: at((32 - ci) * DAY) }
  if (!valid(`community ${c.key}`, () => C.declaration.$parse(decl), checkCommunity(c), realOrg(c.description, ...c.rules))) continue
  const community = await ensure(c.creator, C.declaration.$nsid, keyOf(KIND.community, ci), C.declaration.$parse(decl) as Record<string, unknown>)
  refs.set(c.key, community)
  expected.communities.push(community.uri)
  const joiners = [...c.members.filter((m) => m !== c.creator), ...(alice.joins.includes(c.key) ? ["alice.test"] : [])]
  for (const [mi, member] of joiners.entries()) {
    const record = C.membership.$parse({ $type: C.membership.$type, community, createdAt: at((31 - ci) * DAY - mi * HOUR) })
    await ensure(member, C.membership.$nsid, keyOf(KIND.membership, ci * 100 + mi), record as Record<string, unknown>)
  }

  for (const [ti, t] of c.threads.entries()) {
    // Threads spread over the last nine days; the newest about a day old.
    const rootAgo = (9 - ci * 1.6 - ti * 0.35) * DAY + (ci * 3 + ti) * HOUR
    const rootText = { $type: POST.$type, text: t.text, community, createdAt: at(rootAgo) }
    const label = `${c.key} thread ${ti}`
    if (!valid(label, () => POST.$parse(rootText), checkPostText(t.text), realOrg(t.text))) {
      if (t.replies.length) dropped.push(`${label}: ${t.replies.length} repl${t.replies.length === 1 ? "y" : "ies"} under it, dropped with it`)
      continue
    }
    const rootRef = await ensure(t.author, POST.$nsid, keyOf(KIND.post, postIndex++), POST.$parse(rootText) as Record<string, unknown>)
    expected.posts.push(rootRef.uri)
    postRefs.push({ ...rootRef, members: c.members })
    const chain: Array<{ uri: string; cid: string } | undefined> = [rootRef]
    for (const [ri, r] of t.replies.entries()) {
      const parent = chain[r.replyTo]
      const rlabel = `${label} reply ${ri + 1}`
      if (!parent) {
        dropped.push(`${rlabel}: its parent was dropped`)
        chain.push(undefined)
        continue
      }
      const record = { $type: POST.$type, text: r.text, reply: { root: rootRef, parent }, createdAt: at(rootAgo - (ri + 1) * 3 * HOUR) }
      if (!valid(rlabel, () => POST.$parse(record), checkPostText(r.text), realOrg(r.text))) {
        chain.push(undefined)
        continue
      }
      const ref = await ensure(r.author, POST.$nsid, keyOf(KIND.post, postIndex++), POST.$parse(record) as Record<string, unknown>)
      expected.posts.push(ref.uri)
      chain.push(ref)
    }
  }
}
console.log(`✓ ${expected.communities.length} communities, ${expected.posts.length} posts`)

// --- job postings ------------------------------------------------------------------

const J = sh.authentiq.job.posting
for (const [i, p] of postings.entries()) {
  const record = { $type: J.$type, ...p.record, createdAt: at((19 - i) * DAY - i * HOUR) }
  const label = `posting ${p.key} (${p.record.title})`
  if (!valid(label, () => J.$parse(record), checkPosting(record as never), realOrg(p.record.organization, p.record.description))) continue
  const ref = await ensure(p.by, J.$nsid, keyOf(KIND.posting, i), J.$parse(record) as Record<string, unknown>)
  expected.postings.push(ref.uri)
}
console.log(`✓ ${expected.postings.length} job postings`)

// --- likes and follows: deterministic, not generated ---------------------------------

const rand = prng(SEED + 7)
let likes = 0
for (const [i, post] of postRefs.entries()) {
  for (const [j, liker] of shuffle(post.members, rand).slice(0, 2).entries()) {
    const record = sh.authentiq.feed.like.$parse({ $type: sh.authentiq.feed.like.$type, subject: { uri: post.uri, cid: post.cid }, createdAt: at(DAY / 2 + i * HOUR) })
    await ensure(liker, sh.authentiq.feed.like.$nsid, keyOf(KIND.like, i * 10 + j), record as Record<string, unknown>)
    likes++
  }
}
let follows = 0
const followPlan: Array<[string, string]> = alice.follows.map((h) => ["alice.test", h])
for (const c of communities) {
  for (const member of c.members) {
    for (const other of shuffle(c.members.filter((m) => m !== member), rand).slice(0, 2)) followPlan.push([member, other])
  }
}
const seenFollow = new Set<string>()
for (const [i, [by, subject]] of followPlan.entries()) {
  if (seenFollow.has(`${by}→${subject}`)) continue
  seenFollow.add(`${by}→${subject}`)
  const record = sh.authentiq.graph.follow.$parse({ $type: sh.authentiq.graph.follow.$type, subject: (await session(subject)).did, createdAt: at(10 * DAY - i * 60_000) })
  await ensure(by, sh.authentiq.graph.follow.$nsid, keyOf(KIND.follow, i), record as Record<string, unknown>)
  follows++
}
console.log(`✓ ${likes} likes, ${follows} follows`)
console.log(`  ${written} record(s) written, ${unchanged} already up to date`)
if (dropped.length) {
  console.log(`· dropped ${dropped.length} record(s) that failed the lexicon, the indexer's rules or the real-organisation check:`)
  for (const d of dropped) console.log(`    ${d}`)
}

// --- wait for the index and the embeddings -------------------------------------------

const db = new SQL(`postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`)
const started = performance.now()
let last = ""
for (;;) {
  const [row] = await db`
    select
      (select count(*)::int from profile where did in ${db(expected.profiles)}) as profiles,
      (select count(*)::int from embedding where subject in ${db([...expected.profiles, ...expected.postings])}
        and vector is not null and dirty_at is null) as embedded,
      (select count(*)::int from community where uri in ${db(expected.communities)}) as communities,
      (select count(*)::int from post where uri in ${db(expected.posts)}) as posts,
      (select count(*)::int from job_posting where uri in ${db(expected.postings)}) as postings`
  const status = `indexed: ${row.profiles}/${expected.profiles.length} profiles, ${row.communities}/${expected.communities.length} communities, ${row.posts}/${expected.posts.length} posts, ${row.postings}/${expected.postings.length} postings; ${row.embedded}/${expected.profiles.length + expected.postings.length} embedded`
  if (status !== last) console.log(`  ${status}`)
  last = status
  if (
    row.profiles === expected.profiles.length &&
    row.communities === expected.communities.length &&
    row.posts === expected.posts.length &&
    row.postings === expected.postings.length &&
    row.embedded === expected.profiles.length + expected.postings.length
  )
    break
  if (performance.now() - started > WAIT_MS) {
    console.log(`✗ timed out after ${WAIT_MS / 1000} s — is the AppView running (bun run dev)?`)
    await db.close()
    process.exit(1)
  }
  await Bun.sleep(500)
}
await db.close()
console.log(`✓ demo cast indexed and embedded (${Math.round(performance.now() - started)} ms)`)
