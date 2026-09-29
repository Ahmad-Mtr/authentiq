/**
 * End-to-end check of phase 8, feed composition, against the live stack:
 *
 *   feed.generator record → DID document → #authentiq_fg endpoint
 *     → getFeedSkeleton → clamp → hydrate under the AppView's policy
 *
 * It uses the seeded feeds (`bun run seed:feeds`) and accounts, plus six
 * throwaway accounts it deletes at the end: a viewer (A), three posters
 * (B, C, D), one to deactivate (E) and a publisher (P) of test generator
 * records. To test what the AppView does with a generator it cannot trust,
 * the script runs its own services on the ports the AppView's development
 * allowlist names (FETCH_ALLOW):
 *
 *   :2590  a scripted generator: bad items, slow, garbage, huge, 500, redirect
 *   :2591  a DID document whose endpoint is http://127.0.0.1:2599
 *   :2592  a DID document whose endpoint is http://169.254.169.254
 *   :2593  a DID document whose endpoint is http://10.0.0.1
 *   :2594  nothing (a generator that is down)
 *   :2599  a TCP canary on loopback, outside the allowlist. It counts
 *          connections: every SSRF case that points at it must leave it at 0.
 *
 * Every wait is a poll with a timeout. Needs `bun run dev`.
 *
 *   bun run verify:feeds
 */
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Secp256k1Keypair } from "@atproto/crypto"
import { SQL } from "bun"
import { LOCAL_NETWORK } from "@workspace/atproto"
import { signInToWeb } from "./lib/web-session.ts"

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
const FEEDGEN = process.env.FEEDGEN_URL ?? LOCAL_NETWORK.feedgenUrl
const WEB = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000"
const APPVIEW_DID = appviewEnv.SERVICE_DID ?? "did:web:localhost%3A2584"
const FEEDGEN_DID = feedgenEnv.SERVICE_DID ?? "did:web:localhost%3A2585"
const PUBLISHER = feedgenEnv.PUBLISHER ?? "authentiq-feeds.test"
const PDS_ADMIN = `Basic ${btoa(`admin:${infraEnv.PDS_ADMIN_PASSWORD}`)}`
const TIMEOUT_MS = 10_000
const EMBED_TIMEOUT_MS = 30_000

const NS = "sh.authentiq"
const Q = {
  getFeed: `${NS}.feed.getFeed`,
  skeleton: `${NS}.feed.getFeedSkeleton`,
  describe: `${NS}.feed.describeFeedGenerator`,
  timeline: `${NS}.feed.getTimeline`,
  generator: `${NS}.feed.getFeedGenerator`,
  list: `${NS}.feed.listFeedGenerators`,
  pinned: `${NS}.feed.getPinnedFeeds`,
  authorFeed: `${NS}.feed.getAuthorFeed`,
  hide: `${NS}.community.hidePost`,
}
const GENERATOR = `${NS}.feed.generator`
const POST = `${NS}.feed.post`
const POSTING = `${NS}.job.posting`

const db = new SQL(
  `postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`
)

let failures = 0
let passes = 0
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) passes++
  else failures++
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
}
const note = (label: string, detail = "") =>
  console.log(`· ${label}${detail ? ` — ${detail}` : ""}`)
const section = (title: string) => console.log(`\n${title}`)

async function until<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs = TIMEOUT_MS
) {
  const started = performance.now()
  while (performance.now() - started < timeoutMs) {
    const value = await probe().catch(() => undefined)
    if (value) return { value, ms: Math.round(performance.now() - started) }
    await Bun.sleep(50)
  }
  return { value: undefined, ms: timeoutMs }
}
const took = (r: { value: unknown; ms: number }, timeoutMs = TIMEOUT_MS) =>
  r.value ? `${r.ms} ms` : `timed out after ${timeoutMs} ms`

type Res = { status: number; ok: boolean; body: Record<string, any>; ms: number }

async function call(
  base: string,
  method: string,
  opts: {
    body?: unknown
    params?: Record<string, string>
    auth?: string
    post?: boolean
  } = {}
): Promise<Res> {
  const url = new URL(`/xrpc/${method}`, base)
  for (const [k, v] of Object.entries(opts.params ?? {}))
    url.searchParams.set(k, v)
  const started = performance.now()
  const res = await fetch(url, {
    method: opts.body === undefined && !opts.post ? "GET" : "POST",
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, any>
  return {
    status: res.status,
    ok: res.ok,
    body,
    ms: Math.round(performance.now() - started),
  }
}

// --- accounts ---------------------------------------------------------------------

type Account = {
  name: string
  handle: string
  did: string
  jwt: string
  web?: Awaited<ReturnType<typeof signInToWeb>>
}
const accounts: Array<Account> = []
const suffix = Date.now().toString(36)

async function createAccount(name: string): Promise<Account> {
  const handle = `f${name}-${suffix}.test`
  const res = await call(PDS, "com.atproto.server.createAccount", {
    body: {
      handle,
      email: `f${name}-${suffix}@authentiq.test`,
      password: "password",
    },
  })
  if (!res.ok) throw new Error(`createAccount ${handle}: ${res.body.message}`)
  const a = {
    name,
    handle,
    did: res.body.did as string,
    jwt: `Bearer ${res.body.accessJwt}`,
  }
  accounts.push(a)
  return a
}

async function signIn(handle: string): Promise<Account> {
  const res = await call(PDS, "com.atproto.server.createSession", {
    body: { identifier: handle, password: "password" },
  })
  if (!res.ok) throw new Error(`${handle}: ${res.body.message} — run the seeds`)
  return {
    name: handle,
    handle,
    did: res.body.did,
    jwt: `Bearer ${res.body.accessJwt}`,
  }
}

/** A single-use service auth token from the account's own PDS. */
async function token(a: Account, aud: string, lxm: string) {
  const res = await call(PDS, "com.atproto.server.getServiceAuth", {
    params: { aud, lxm, exp: String(Math.floor(Date.now() / 1000) + 60) },
    auth: a.jwt,
  })
  if (!res.ok) throw new Error(`getServiceAuth: ${res.body.message}`)
  return `Bearer ${res.body.token}`
}

/** A token claiming `iss`, well formed, but signed by a key nobody published. */
async function forged(claims: { iss: string; aud: string; lxm: string }) {
  const attacker = await Secp256k1Keypair.create()
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const unsigned = `${b64({ alg: "ES256K", typ: "JWT" })}.${b64({
    ...claims,
    exp: Math.floor(Date.now() / 1000) + 60,
    jti: crypto.randomUUID(),
  })}`
  const sig = Buffer.from(
    await attacker.sign(new TextEncoder().encode(unsigned))
  ).toString("base64url")
  return `Bearer ${unsigned}.${sig}`
}

const createRecord = (a: Account, collection: string, record: unknown, rkey?: string) =>
  call(PDS, "com.atproto.repo.createRecord", {
    body: { repo: a.did, collection, record, ...(rkey ? { rkey } : {}) },
    auth: a.jwt,
  })
const deleteRecord = (a: Account, uri: string) =>
  call(PDS, "com.atproto.repo.deleteRecord", {
    body: { repo: a.did, collection: uri.split("/")[3], rkey: uri.split("/")[4] },
    auth: a.jwt,
  })
const post = (text: string, extra: Record<string, unknown> = {}) => ({
  $type: POST,
  text,
  createdAt: new Date().toISOString(),
  ...extra,
})
const posting = (fields: Record<string, unknown>) => ({
  $type: POSTING,
  title: "Probe role",
  organization: "Probe Ltd",
  description: "A probe posting.",
  salary: { min: 50_000, max: 60_000, currency: "EUR", period: "year" },
  createdAt: new Date().toISOString(),
  ...fields,
})
const generatorRecord = (did: string, displayName: string) => ({
  $type: GENERATOR,
  did,
  displayName,
  description: "A generator verify:feeds publishes.",
  createdAt: new Date().toISOString(),
})

const indexed = (table: string, uri: string) =>
  until(async () =>
    (await db.unsafe(`select 1 from ${table} where uri = $1`, [uri])).length > 0
  )

/** getFeed, as the web BFF calls it: signed in, a token for the feed's generator. */
async function getFeed(
  feed: string,
  viewer?: Account,
  params: Record<string, string> = {},
  aud?: string
) {
  let auth: string | undefined
  if (viewer) {
    const did =
      aud ?? (await call(APPVIEW, Q.generator, { params: { feed } })).body.view?.did
    auth = await token(viewer, did, Q.skeleton)
  }
  return call(APPVIEW, Q.getFeed, { params: { feed, ...params }, auth })
}
const uris = (r: Res) =>
  ((r.body.feed ?? []) as Array<any>).map((i) => (i.post?.uri ?? i.uri) as string)
const authorsOf = (r: Res) =>
  new Set(((r.body.feed ?? []) as Array<any>).map((i) => i.post?.author?.did))

// --- scripted services ---------------------------------------------------------------

const SCRIPTED_DID = "did:web:localhost%3A2590"
const didDoc = (id: string, endpoint: string) => ({
  "@context": ["https://www.w3.org/ns/did/v1"],
  id,
  service: [
    { id: "#authentiq_fg", type: "AuthentiqFeedGenerator", serviceEndpoint: endpoint },
  ],
})

/** What the scripted generator returns for each feed, by record key. */
const skeletons = new Map<string, unknown>()
const OPAQUE_CURSOR = "opaque/Ω:cursor?with=odd&chars"
const received: Array<{ rkey: string; cursor: string | null; auth: string | null }> = []

function startScripted() {
  return Bun.serve({
    port: 2590,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/.well-known/did.json") {
        return Response.json(didDoc(SCRIPTED_DID, "http://localhost:2590"))
      }
      if (url.pathname !== `/xrpc/${Q.skeleton}`) {
        return new Response("not found", { status: 404 })
      }
      const rkey = (url.searchParams.get("feed") ?? "").split("/").pop()!
      received.push({
        rkey,
        cursor: url.searchParams.get("cursor"),
        auth: req.headers.get("authorization"),
      })
      switch (rkey) {
        case "slow":
          await Bun.sleep(10_000)
          return Response.json({ feed: [] })
        case "garbage":
          return new Response("<html>definitely not a skeleton", {
            headers: { "content-type": "text/html" },
          })
        case "wrongshape":
          return Response.json({ feed: "nope" })
        case "huge":
          return Response.json({
            feed: Array.from({ length: 5000 }, (_, i) => ({
              $type: `${NS}.feed.defs#skeletonPost`,
              post: `at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/${POST}/${"x".repeat(40)}${i}`,
            })),
          })
        case "error500":
          return Response.json(
            { error: "InternalServerError", message: "db password is hunter2" },
            { status: 500 }
          )
        case "redirect":
          return Response.redirect("http://169.254.169.254/latest/meta-data", 302)
        case "longcursor":
          return Response.json({ feed: [], cursor: "x".repeat(600) })
        default:
          return Response.json(skeletons.get(rkey) ?? { feed: [] })
      }
    },
  })
}

const docHits = { 2591: 0, 2592: 0, 2593: 0 }
const docServers = (
  [
    [2591, "http://127.0.0.1:2599"],
    [2592, "http://169.254.169.254"],
    [2593, "http://10.0.0.1"],
  ] as const
).map(([port, endpoint]) =>
  Bun.serve({
    port,
    fetch(req) {
      if (new URL(req.url).pathname !== "/.well-known/did.json") {
        return new Response("not found", { status: 404 })
      }
      docHits[port]++
      return Response.json(didDoc(`did:web:localhost%3A${port}`, endpoint))
    },
  })
)

let canary = 0
const canaries = ["127.0.0.1", "::1"].map((hostname) =>
  Bun.listen({
    hostname,
    port: 2599,
    socket: {
      open(socket) {
        canary++
        socket.end()
      },
      data() {},
    },
  })
)

let scripted = startScripted()

// --- run ------------------------------------------------------------------------

try {
  const publisher = (
    await call(PDS, "com.atproto.identity.resolveHandle", {
      params: { handle: PUBLISHER },
    })
  ).body.did as string
  if (!publisher) throw new Error(`${PUBLISHER} not found — run bun run seed:feeds`)
  const FIRST = {
    following: `at://${publisher}/${GENERATOR}/following`,
    communities: `at://${publisher}/${GENERATOR}/my-communities`,
    jobs: `at://${publisher}/${GENERATOR}/jobs-for-you`,
    pulse: `at://${publisher}/${GENERATOR}/industry-pulse`,
  }

  const [A, B, C, D, E, P] = await Promise.all(
    ["a", "b", "c", "d", "e", "p"].map((n) => createAccount(n))
  )
  const all = [A!, B!, C!, D!, E!, P!]
  const seen = await until(async () => {
    const [row] =
      await db`select count(*)::int as n from actor where did in ${db(all.map((a) => a.did))}`
    return row.n === all.length
  })
  check(
    Boolean(seen.value),
    "six throwaway accounts created on the PDS",
    `${all.map((a) => a.handle.split("-")[0]).join(", ")} (-${suffix}.test), ${took(seen)}`
  )
  A!.web = await signInToWeb({ web: WEB, pds: PDS, handle: A!.handle, password: "password" })
  check(true, "A signed in to the web app over OAuth")

  // ---------------------------------------------------------------------------
  section("1. identity: the feedgen's did:web, and record → DID → endpoint through the AppView")

  const doc = await (await fetch(`${FEEDGEN}/.well-known/did.json`)).json()
  const fg = (doc.service ?? []).find((s: any) => s.id === "#authentiq_fg")
  check(
    doc.id === FEEDGEN_DID && fg?.type === "AuthentiqFeedGenerator" && fg?.serviceEndpoint === FEEDGEN,
    "the feedgen serves /.well-known/did.json with an #authentiq_fg service",
    `${doc.id} → ${fg?.type} ${fg?.serviceEndpoint}`
  )
  check(
    !doc.verificationMethod,
    "it publishes no key: it never signs, it is only ever a token's audience"
  )
  const described = await call(FEEDGEN, Q.describe)
  const describedUris = ((described.body.feeds ?? []) as Array<any>).map((f) => f.uri)
  check(
    described.body.did === FEEDGEN_DID &&
      Object.values(FIRST).every((u) => describedUris.includes(u)),
    "describeFeedGenerator lists the four first-party feeds",
    describedUris.map((u: string) => u.split("/").pop()).join(", ")
  )
  const listed = await call(APPVIEW, Q.list, { params: { limit: "100" } })
  const views = new Map(
    ((listed.body.feeds ?? []) as Array<any>).map((g) => [g.uri, g])
  )
  check(
    Object.values(FIRST).every((u) => views.get(u)?.did === FEEDGEN_DID),
    "the AppView indexed their generator records, each naming the feedgen's DID",
    `${views.size} feed(s) listed, publisher ${PUBLISHER}`
  )
  check(
    [...views.values()].every((g) => !Object.keys(g).some((k) => /count/i.test(k))),
    "no like or subscriber count on any feed"
  )
  const pulseAnon = await getFeed(FIRST.pulse)
  check(
    pulseAnon.ok && (pulseAnon.body.feed as Array<any>).length > 0,
    "getFeed(industry-pulse) resolves the chain and returns hydrated posts",
    `${pulseAnon.status}, ${(pulseAnon.body.feed ?? []).length} posts, ${pulseAnon.ms} ms`
  )

  // The feedgen's database access: the read-only role db:migrate creates.
  const reader = new SQL(feedgenEnv.DATABASE_URL!)
  const readerName = new URL(feedgenEnv.DATABASE_URL!).username
  const canRead = await reader`select count(*)::int as n from post`.then(() => true, () => false)
  const denied = async (q: Promise<unknown>) =>
    q.then(() => "allowed", (e: Error) => e.message)
  const sessions = await denied(reader`select * from web_session limit 1`)
  const oauth = await denied(reader`select * from oauth_session limit 1`)
  const pins = await denied(reader`select * from feed_pin limit 1`)
  const write = await denied(reader`delete from post where uri = 'at://nothing'`)
  await reader.close()
  check(
    readerName === "feedgen_reader" && canRead,
    "the feedgen connects as feedgen_reader, which can read the index",
    readerName
  )
  check(
    [sessions, oauth, pins].every((m) => /permission denied/.test(m)),
    "…and cannot read sessions, OAuth tokens or pins",
    sessions
  )
  check(/read-only|permission denied/.test(write), "…and cannot write", write)

  // ---------------------------------------------------------------------------
  section("2. following: exactly the people you follow; follow adds, unfollow removes")

  const alice = await signIn("alice.test")
  const aliceFeed = await getFeed(FIRST.following, alice, { limit: "100" })
  const aliceFollows = new Set(
    (
      await db`select f.subject from follow f join actor a on a.did = f.subject and a.active where f.did = ${alice.did}`
    ).map((r: any) => r.subject as string)
  )
  const expectedAlice = new Set<string>()
  for (const did of aliceFollows) {
    const r = await call(APPVIEW, Q.authorFeed, { params: { actor: did, limit: "100" } })
    for (const u of uris(r)) expectedAlice.add(u)
  }
  const gotAlice = uris(aliceFeed)
  check(
    aliceFeed.ok &&
      gotAlice.length === expectedAlice.size &&
      gotAlice.every((u) => expectedAlice.has(u)),
    "alice's following feed is exactly the posts of the people she follows",
    `${gotAlice.length} posts by ${aliceFollows.size} people; the union of their author feeds has ${expectedAlice.size}`
  )
  check(
    [...authorsOf(aliceFeed)].every((d) => aliceFollows.has(d)),
    "no post by anyone she does not follow"
  )
  const aliceTimeline = await call(APPVIEW, Q.timeline, {
    params: { limit: "100" },
    auth: await token(alice, APPVIEW_DID, Q.timeline),
  })
  check(
    JSON.stringify(uris(aliceTimeline)) === JSON.stringify(gotAlice),
    "getTimeline (AppView-native) returns the same posts in the same order",
    `${uris(aliceTimeline).length} posts`
  )

  // Throwaways: B, C and D post; A follows B and C through the web app.
  const bPosts: Array<string> = []
  for (let i = 1; i <= 6; i++) {
    bPosts.push((await createRecord(B!, POST, post(`B's post ${i} ${suffix}`))).body.uri)
  }
  const cPost = (await createRecord(C!, POST, post(`C's post ${suffix}`))).body.uri
  const dPost = (await createRecord(D!, POST, post(`D's post ${suffix}`))).body.uri
  await Promise.all([...bPosts, cPost, dPost].map((u) => indexed("post", u)))
  const follow = async (subject: Account) => {
    const r = await A!.web!.fetch("/api/follows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: subject.handle }),
    })
    return (await r.json()) as { uri: string }
  }
  await follow(B!)
  const followC = await follow(C!)
  const aFollowing = async () => new Set(uris(await getFeed(FIRST.following, A!, { limit: "100" })))
  let feedA = await aFollowing()
  check(
    [...bPosts, cPost].every((u) => feedA.has(u)) && !feedA.has(dPost) && feedA.size === 7,
    "A follows B and C through the web app: A's following feed is their 7 posts, not D's",
    `${feedA.size} posts`
  )
  await follow(D!)
  const addedD = await until(async () => (await aFollowing()).has(dPost))
  check(Boolean(addedD.value), "following D adds D's post", took(addedD))
  await A!.web!.fetch("/api/records/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri: followC.uri }),
  })
  const removedC = await until(async () => {
    const s = await aFollowing()
    return !s.has(cPost) && s.has(dPost) && bPosts.every((u) => s.has(u))
  })
  check(Boolean(removedC.value), "unfollowing C removes C's post, and nothing else", took(removedC))
  feedA = await aFollowing()
  const timelineA = new Set(
    uris(
      await call(APPVIEW, Q.timeline, {
        params: { limit: "100" },
        auth: await token(A!, APPVIEW_DID, Q.timeline),
      })
    )
  )
  check(
    feedA.size === timelineA.size && [...feedA].every((u) => timelineA.has(u)),
    "A's timeline agrees with A's following feed",
    `${feedA.size} posts`
  )

  // ---------------------------------------------------------------------------
  section("3. viewer auth at the feedgen: forged, misaddressed and replayed tokens")

  const skeletonDirect = (feed: string, auth?: string) =>
    call(FEEDGEN, Q.skeleton, { params: { feed, limit: "10" }, auth })
  const good = await token(A!, FEEDGEN_DID, Q.skeleton)
  const okDirect = await skeletonDirect(FIRST.following, good)
  check(
    okDirect.ok && (okDirect.body.feed as Array<any>).length > 0,
    "a token from A's PDS (aud = feedgen, lxm = getFeedSkeleton) works",
    `${okDirect.status}, ${(okDirect.body.feed ?? []).length} items`
  )
  const replay = await skeletonDirect(FIRST.following, good)
  check(
    replay.status === 401 && replay.body.error === "BadJwt",
    "replaying the same token → 401",
    `${replay.status} ${replay.body.error}: ${replay.body.message}`
  )
  const wrongKey = await skeletonDirect(
    FIRST.following,
    await forged({ iss: A!.did, aud: FEEDGEN_DID, lxm: Q.skeleton })
  )
  check(
    wrongKey.status === 401 && wrongKey.body.error === "BadJwtSignature",
    "a token claiming A, signed by the wrong key → 401",
    `${wrongKey.status} ${wrongKey.body.error}`
  )
  const wrongAud = await skeletonDirect(
    FIRST.following,
    await token(A!, APPVIEW_DID, Q.skeleton)
  )
  check(
    wrongAud.status === 401 && wrongAud.body.error === "BadJwtAudience",
    "A's real token addressed to the AppView → 401",
    `${wrongAud.status} ${wrongAud.body.error}`
  )
  const wrongLxm = await skeletonDirect(
    FIRST.following,
    await token(A!, FEEDGEN_DID, Q.timeline)
  )
  check(
    wrongLxm.status === 401 && wrongLxm.body.error === "BadJwtLexiconMethod",
    "A's real token for another method → 401",
    `${wrongLxm.status} ${wrongLxm.body.error}`
  )
  for (const [feed, name] of [
    [FIRST.following, "following"],
    [FIRST.communities, "my-communities"],
    [FIRST.jobs, "jobs-for-you"],
  ] as const) {
    const anon = await skeletonDirect(feed)
    check(
      anon.status === 401 && anon.body.error === "AuthRequired",
      `anonymous ${name} → AuthRequired, as documented`,
      `${anon.status} ${anon.body.error}`
    )
  }
  const pulseDirect = await skeletonDirect(FIRST.pulse)
  const pulsePosts = ((pulseDirect.body.feed ?? []) as Array<any>).map((i) => i.post)
  const pulseRows = pulsePosts.length
    ? await db`select uri from post where uri in ${db(pulsePosts)} and community_uri is not null and reply_root_uri is null`
    : []
  check(
    pulseDirect.ok && pulsePosts.length > 0 && pulseRows.length === pulsePosts.length,
    "anonymous industry-pulse → recent community threads, the same for everyone, as documented",
    `${pulsePosts.length} top-level community posts`
  )
  // Through the AppView: a bad token is refused there too, never downgraded.
  const viaAppViewForged = await call(APPVIEW, Q.getFeed, {
    params: { feed: FIRST.following },
    auth: await forged({ iss: A!.did, aud: FEEDGEN_DID, lxm: Q.skeleton }),
  })
  check(
    viaAppViewForged.status === 401,
    "getFeed with a forged token → 401 at the AppView, not an anonymous feed",
    `${viaAppViewForged.status} ${viaAppViewForged.body.error}`
  )
  const viaAppViewOtherGen = await call(APPVIEW, Q.getFeed, {
    params: { feed: FIRST.following },
    auth: await token(A!, SCRIPTED_DID, Q.skeleton),
  })
  check(
    viaAppViewOtherGen.status === 401 && viaAppViewOtherGen.body.error === "BadJwtAudience",
    "getFeed with A's token for a different generator → 401",
    `${viaAppViewOtherGen.status} ${viaAppViewOtherGen.body.error}`
  )
  const anonViaAppView = await getFeed(FIRST.following)
  check(
    anonViaAppView.status === 401 && anonViaAppView.body.error === "AuthRequired",
    "anonymous getFeed(following) → AuthRequired from the generator, passed on",
    `${anonViaAppView.status} ${anonViaAppView.body.error}`
  )

  // ---------------------------------------------------------------------------
  section("4. jobs-for-you: open postings, closest first, no scores")

  const seeker = await signIn("tal-022.test")
  const twinFields = {
    title: `Analytics Engineer ${suffix}`,
    description:
      "Build and own our dbt models and Airflow pipelines on Snowflake. SQL every day.",
    skills: ["SQL", "dbt", "Airflow", "Snowflake"],
    employmentType: "full-time",
    locationType: "remote",
  }
  const twinOpen = (await createRecord(P!, POSTING, posting(twinFields))).body.uri
  const twinClosed = (
    await createRecord(P!, POSTING, posting({ ...twinFields, closeDate: "2026-01-15" }))
  ).body.uri
  const bothEmbedded = await until(async () => {
    const rows =
      await db`select 1 from embedding where subject in ${db([twinOpen, twinClosed])} and vector is not null and dirty_at is null`
    return rows.length === 2
  }, EMBED_TIMEOUT_MS)
  check(
    Boolean(bothEmbedded.value),
    "two identical data-engineering postings, one closed on 2026-01-15, are indexed and embedded",
    took(bothEmbedded, EMBED_TIMEOUT_MS)
  )
  const jobsSkel = await call(FEEDGEN, Q.skeleton, {
    params: { feed: FIRST.jobs, limit: "100" },
    auth: await token(seeker, FEEDGEN_DID, Q.skeleton),
  })
  const jobItems = (jobsSkel.body.feed ?? []) as Array<any>
  const jobUris = jobItems.map((i) => i.job as string)
  const openRows = jobUris.length
    ? await db`select uri from job_posting where uri in ${db(jobUris)} and (closes_at is null or closes_at > now())`
    : []
  check(
    jobsSkel.ok && jobItems.length > 0 && jobItems.every((i) => i.$type === `${NS}.feed.defs#skeletonJob`),
    "the skeleton for tal-022 (a data engineer) is job postings only",
    `${jobItems.length} postings`
  )
  check(
    openRows.length === jobUris.length && jobUris.includes(twinOpen) && !jobUris.includes(twinClosed),
    "every one is open: the open twin is in, its closed twin is not",
    `${openRows.length}/${jobUris.length} open`
  )
  const sims = jobUris.length
    ? await db`select j.uri, j.title, 1 - (e.vector <=> (select vector from embedding where subject = ${seeker.did})) as sim
        from job_posting j join embedding e on e.subject = j.uri where j.uri in ${db(jobUris)}`
    : []
  const simOf = new Map(sims.map((r: any) => [r.uri as string, Number(r.sim)]))
  const titleOf = new Map(sims.map((r: any) => [r.uri as string, r.title as string]))
  const ordered = jobUris.every((u, i) => i === 0 || simOf.get(jobUris[i - 1]!)! >= simOf.get(u)! - 1e-9)
  check(
    ordered && /Data Engineer|Analytics Engineer/.test(titleOf.get(jobUris[0]!) ?? ""),
    "closest match first: the list opens with data engineering, in non-increasing similarity",
    jobUris.slice(0, 4).map((u) => titleOf.get(u)).join(" · ")
  )
  check(
    Math.min(...jobUris.map((u) => simOf.get(u)!)) >= 0.8,
    "only postings she would see as a partial or strong match (phase 7's bands)"
  )
  check(
    jobItems.every((i) => Object.keys(i).sort().join() === "$type,job") &&
      (jobsSkel.body.cursor === undefined || /^o:\d+$/.test(jobsSkel.body.cursor)),
    "no score in the skeleton: each item is {$type, job}, and the cursor is an offset",
    `cursor ${jobsSkel.body.cursor ?? "none"}`
  )
  const jobsFeed = await getFeed(FIRST.jobs, seeker, { limit: "100" })
  check(
    jobsFeed.ok &&
      (jobsFeed.body.feed as Array<any>).every((i) => i.$type === `${NS}.job.defs#jobView`) &&
      !/"(score|similarity|label|rank)"/.test(JSON.stringify(jobsFeed.body)),
    "hydrated through getFeed: jobViews, with no score, similarity, label or rank anywhere",
    `${(jobsFeed.body.feed ?? []).length} postings`
  )
  const noProfile = await getFeed(FIRST.jobs, A!)
  check(
    noProfile.ok && (noProfile.body.feed as Array<any>).length === 0,
    "someone with no profile gets an empty feed, not someone else's"
  )

  // ---------------------------------------------------------------------------
  section("5. the AppView overrides the skeleton")

  // P runs a community; B posts in it and P hides that post.
  const community = (
    await createRecord(P!, `${NS}.community.declaration`, {
      $type: `${NS}.community.declaration`,
      name: `Probe ${suffix}`,
      topic: "Probing",
      createdAt: new Date().toISOString(),
    })
  ).body
  await createRecord(B!, `${NS}.community.membership`, {
    $type: `${NS}.community.membership`,
    community: { uri: community.uri, cid: community.cid },
    createdAt: new Date().toISOString(),
  })
  const hiddenPost = (
    await createRecord(B!, POST, post(`B's hidden post ${suffix}`, {
      community: { uri: community.uri, cid: community.cid },
    }))
  ).body.uri
  const nonMember = (
    await createRecord(C!, POST, post(`C, not a member ${suffix}`, {
      community: { uri: community.uri, cid: community.cid },
    }))
  ).body.uri
  await Promise.all([indexed("post", hiddenPost), indexed("post", nonMember), indexed("community", community.uri)])
  await until(async () => (await db`select 1 from membership where did = ${B!.did}`).length > 0)
  const hid = await call(APPVIEW, Q.hide, {
    body: { community: community.uri, post: hiddenPost },
    auth: await token(P!, APPVIEW_DID, Q.hide),
  })
  // A deleted post, a deactivated author's post, a closed and a salary-less posting.
  const deleted = (await createRecord(B!, POST, post(`B's deleted post ${suffix}`))).body.uri
  await indexed("post", deleted)
  await deleteRecord(B!, deleted)
  const ePost = (await createRecord(E!, POST, post(`E's post ${suffix}`))).body.uri
  await indexed("post", ePost)
  await call(PDS, "com.atproto.server.deactivateAccount", { body: {}, auth: E!.jwt })
  const openJob = (await createRecord(P!, POSTING, posting({ title: `Open ${suffix}` }))).body.uri
  const closedJob = (
    await createRecord(P!, POSTING, posting({ title: `Closed ${suffix}`, closeDate: "2026-02-01" }))
  ).body.uri
  const noSalary = { ...posting({ title: `No salary ${suffix}` }) } as Record<string, unknown>
  delete noSalary.salary
  const salaryLess = (await createRecord(P!, POSTING, noSalary)).body.uri
  // Sentinel: once it is indexed, P's earlier records have been seen.
  const sentinel = (await createRecord(P!, POSTING, posting({ title: `Sentinel ${suffix}` }))).body.uri
  const ready = await until(async () => {
    const [gone] = await db`select count(*)::int as n from post where uri = ${deleted}`
    const [inactive] = await db`select active from actor where did = ${E!.did}`
    const sent = await db`select 1 from job_posting where uri = ${sentinel}`
    return gone.n === 0 && inactive?.active === false && sent.length > 0
  })
  check(
    hid.ok && Boolean(ready.value),
    "set up: a hidden community post, a deleted post, a deactivated author, a closed and a salary-less posting",
    took(ready)
  )

  const sp = (uri: string) => ({ $type: `${NS}.feed.defs#skeletonPost`, post: uri })
  const sj = (uri: string) => ({ $type: `${NS}.feed.defs#skeletonJob`, job: uri })
  const [G1, G2, G3, G4, G5, G6] = bPosts as [string, string, string, string, string, string]
  skeletons.set("policy", {
    cursor: OPAQUE_CURSOR,
    feed: [
      sp(G1),
      sp(hiddenPost),
      sp(G1),
      sp(deleted),
      sp(ePost),
      sj(closedJob),
      sj(salaryLess),
      sj(openJob),
      sp(nonMember),
      sp(community.uri), // not a post
      sp(openJob), // a posting, labelled as a post
      sj(G2), // a post, labelled as a posting
      { $type: "com.example.feed.defs#skeletonVideo", video: G3 },
      { post: G3 }, // no $type
      42,
      null,
      sp(G2),
      sp(G3),
      sp(G4),
      sp(G5),
      sp(G6),
    ],
  })
  const policyUri = (
    await createRecord(P!, GENERATOR, generatorRecord(SCRIPTED_DID, "Policy probe"), "policy")
  ).body.uri
  await indexed("feed_generator", policyUri)
  const policy = await getFeed(policyUri, A!, { limit: "11" }, SCRIPTED_DID)
  const got = uris(policy)
  const expectedOrder = [G1, openJob, nonMember, G2, G3, G4]
  check(
    policy.ok && JSON.stringify(got) === JSON.stringify(expectedOrder),
    "limit 11, 21 items returned: the feed is exactly the 6 showable ones, in the generator's order",
    `${got.length} items`
  )
  const bad = {
    "the hidden community post": hiddenPost,
    "the deleted post": deleted,
    "the deactivated author's post": ePost,
    "the closed posting": closedJob,
    "the salary-less posting": salaryLess,
    "the community (not a post)": community.uri,
  }
  for (const [label, uri] of Object.entries(bad)) {
    check(!got.includes(uri), `${label} is not in it`)
  }
  check(new Set(got).size === got.length, "no duplicates", `G1 was sent twice`)
  check(
    got.length <= 11 && !got.includes(G5) && !got.includes(G6),
    "the limit is enforced: items past the 11th are cut, not hydrated",
    "G5 and G6 were the 12th and 13th well-formed items"
  )
  const nm = (policy.body.feed as Array<any>).find((i) => i.post?.uri === nonMember)
  check(
    Boolean(nm) && nm.post.community === undefined,
    "a non-member's community post is shown without the community, as on their profile"
  )
  const kinds = (policy.body.feed as Array<any>).map((i) => i.$type.split("#")[1])
  check(
    kinds.join() === "feedViewPost,jobView,feedViewPost,feedViewPost,feedViewPost,feedViewPost",
    "posts and jobs share one open union",
    kinds.join(", ")
  )
  check(
    policy.body.cursor === OPAQUE_CURSOR,
    "the generator's cursor is passed through untouched",
    JSON.stringify(policy.body.cursor)
  )
  await getFeed(policyUri, A!, { limit: "11", cursor: OPAQUE_CURSOR }, SCRIPTED_DID)
  check(
    received.at(-1)?.cursor === OPAQUE_CURSOR,
    "…and handed back to it unchanged on the next page"
  )
  const fwd = received.at(-1)?.auth?.replace(/^Bearer /, "") ?? ""
  const claims = JSON.parse(Buffer.from(fwd.split(".")[1] ?? "", "base64url").toString() || "{}")
  check(
    claims.iss === A!.did && claims.aud === SCRIPTED_DID && claims.lxm === Q.skeleton,
    "the generator received A's token as signed by A's PDS: iss A, aud itself, lxm getFeedSkeleton"
  )
  const replayed = await call(APPVIEW, Q.getFeed, {
    params: { feed: policyUri },
    auth: `Bearer ${fwd}`,
  })
  check(
    replayed.status === 401,
    "a generator cannot replay the token it was given against the AppView",
    `${replayed.status} ${replayed.body.error}`
  )
  const longUri = (
    await createRecord(P!, GENERATOR, generatorRecord(SCRIPTED_DID, "Long cursor"), "longcursor")
  ).body.uri
  await indexed("feed_generator", longUri)
  const long = await getFeed(longUri)
  check(
    long.ok && long.body.cursor === undefined,
    "a 600-character cursor is dropped (cap 512), which ends the feed",
    `${long.status}`
  )

  // ---------------------------------------------------------------------------
  section("6. a slow, broken or unreachable generator fails cleanly, and nothing else does")

  const publish = async (rkey: string, did: string) => {
    const uri = (await createRecord(P!, GENERATOR, generatorRecord(did, rkey), rkey)).body.uri
    await indexed("feed_generator", uri)
    return uri
  }
  const slowUri = await publish("slow", SCRIPTED_DID)
  const slowCall = getFeed(slowUri)
  await Bun.sleep(300)
  const [tl, fol, pul] = await Promise.all([
    call(APPVIEW, Q.timeline, { auth: await token(A!, APPVIEW_DID, Q.timeline) }),
    getFeed(FIRST.following, A!),
    getFeed(FIRST.pulse),
  ])
  const slow = await slowCall
  check(
    tl.ok && fol.ok && pul.ok && Math.max(tl.ms, fol.ms, pul.ms) < 2000,
    "while a generator hangs, the timeline, following and industry-pulse answer normally",
    `${tl.ms} / ${fol.ms} / ${pul.ms} ms`
  )
  check(
    slow.status === 502 && slow.body.error === "FeedUnavailable" && slow.ms < 5000,
    "the hanging feed fails with FeedUnavailable after the 3 s timeout",
    `${slow.status} “${slow.body.message}” in ${slow.ms} ms`
  )
  for (const [rkey, label] of [
    ["garbage", "HTML instead of JSON"],
    ["wrongshape", "JSON that is not a skeleton"],
    ["huge", "a 5000-item, >256 KiB response"],
    ["error500", "a 500 with an error message"],
    ["redirect", "a redirect to 169.254.169.254"],
  ] as const) {
    const r = await getFeed(await publish(rkey, SCRIPTED_DID))
    check(
      r.status === 502 && r.body.error === "FeedUnavailable" && !JSON.stringify(r.body).includes("hunter2"),
      `${label} → FeedUnavailable`,
      `${r.status} “${r.body.message}”`
    )
  }
  const downDns = await getFeed(await publish("unresolvable", "did:web:localhost%3A2594"))
  check(
    downDns.status === 502 && downDns.body.error === "FeedUnavailable",
    "a generator whose DID document cannot be fetched (nothing on :2594) → FeedUnavailable",
    `“${downDns.body.message}”`
  )
  scripted.stop(true)
  const down = await getFeed(policyUri)
  check(
    down.status === 502 && down.body.error === "FeedUnavailable",
    "a generator that goes down after its DID document was cached → FeedUnavailable",
    `“${down.body.message}”`
  )
  scripted = startScripted()
  const everything = await Promise.all([
    call(APPVIEW, Q.timeline, { auth: await token(A!, APPVIEW_DID, Q.timeline) }),
    ...Object.values(FIRST).map((f) => getFeed(f, A!)),
    getFeed(policyUri, A!, {}, SCRIPTED_DID),
  ])
  check(
    everything.every((r) => r.ok),
    "afterwards the timeline, all four first-party feeds and the restarted generator work",
    everything.map((r) => r.status).join(" ")
  )
  const garbageUri = `at://${P!.did}/${GENERATOR}/garbage`
  const apiBroken = await fetch(`${WEB}/api/feeds/feed?feed=${encodeURIComponent(garbageUri)}`)
  const apiBody = (await apiBroken.json()) as Record<string, any>
  check(
    apiBroken.status === 502 && apiBody.ok === false && apiBody.error === "FeedUnavailable",
    "the web API route reports it as FeedUnavailable",
    `${apiBroken.status}`
  )
  const pageBroken = await fetch(`${WEB}/feeds/${encodeURIComponent(P!.did)}/garbage`)
  const pageHtml = await pageBroken.text()
  check(
    pageBroken.status === 200 && pageHtml.includes("This feed is unavailable"),
    "the feed's page renders and says “This feed is unavailable”",
    `${pageBroken.status}`
  )
  const homeBroken = await A!.web!.fetch(`/?feed=${encodeURIComponent(garbageUri)}`)
  const homeHtml = await homeBroken.text()
  check(
    homeBroken.status === 200 && homeHtml.includes("This feed is unavailable") && homeHtml.includes('aria-label="Feeds"'),
    "home with that feed selected still renders, switcher included"
  )

  // ---------------------------------------------------------------------------
  section("7. SSRF: generators on private addresses are refused before any request")

  const before = { canary, ...docHits }
  const refused = async (
    rkey: string,
    did: string,
    stage: "DID document" | "endpoint",
    label: string
  ) => {
    const r = await getFeed(await publish(rkey, did))
    check(
      r.status === 502 &&
        (r.body.message ?? "").includes(`${stage} is at an address this AppView will not contact`),
      label,
      `${r.status} “${r.body.message}” in ${r.ms} ms`
    )
  }
  await refused("ssrf-metadata", "did:web:169.254.169.254", "DID document", "did:web:169.254.169.254 (cloud metadata) → refused")
  await refused("ssrf-private", "did:web:10.0.0.1", "DID document", "did:web:10.0.0.1 → refused")
  await refused("ssrf-loopback-ip", "did:web:127.0.0.1%3A2599", "DID document", "did:web:127.0.0.1%3A2599 → refused")
  await refused("ssrf-loopback-name", "did:web:localhost%3A2599", "DID document", "did:web:localhost%3A2599 (a name for loopback, port not allowlisted) → refused")
  await refused("ssrf-endpoint-loopback", "did:web:localhost%3A2591", "endpoint", "a DID document whose endpoint is http://127.0.0.1:2599 → refused")
  await refused("ssrf-endpoint-metadata", "did:web:localhost%3A2592", "endpoint", "a DID document whose endpoint is http://169.254.169.254 → refused")
  await refused("ssrf-endpoint-private", "did:web:localhost%3A2593", "endpoint", "a DID document whose endpoint is http://10.0.0.1 → refused")
  // The AppView caches DID documents, so whether it fetched them just now
  // depends on earlier runs; the stage in each message above is the check.
  note(
    "DID documents served by :2591–2593 during this run",
    `${docHits[2591] - before[2591] + docHits[2592] - before[2592] + docHits[2593] - before[2593]} (0 when the AppView still had them cached)`
  )
  // Service auth resolves the key of whatever `iss` a token names.
  const ssrfIss = "did:web:127.0.0.1%3A2599"
  const ssrfAppView = await call(APPVIEW, Q.timeline, {
    auth: await forged({ iss: ssrfIss, aud: APPVIEW_DID, lxm: Q.timeline }),
  })
  const ssrfFeedgen = await skeletonDirect(
    FIRST.following,
    await forged({ iss: ssrfIss, aud: FEEDGEN_DID, lxm: Q.skeleton })
  )
  check(
    ssrfAppView.status === 401 && ssrfFeedgen.status === 401,
    "a forged token with iss did:web:127.0.0.1%3A2599 → 401 at the AppView and the feedgen",
    "the phase 3 IdResolver gap"
  )
  await Bun.sleep(200)
  check(
    canary === before.canary,
    "the loopback canary on :2599 received no connection at all",
    `${canary - before.canary} connection(s)`
  )
  const stillWorks = await getFeed(FIRST.following, A!)
  check(stillWorks.ok, "the localhost feedgens still work (the dev allowlist)", `${stillWorks.status}`)

  // ---------------------------------------------------------------------------
  section("8. cursors page through without repeats or gaps")

  const pageAll = async (fetchPage: (cursor?: string) => Promise<Res>) => {
    const out: Array<string> = []
    let cursor: string | undefined
    let pages = 0
    for (; pages < 50; ) {
      const r = await fetchPage(cursor)
      pages++
      if (!r.ok) throw new Error(`page ${pages}: ${r.status} ${r.body.error}`)
      out.push(...uris(r))
      cursor = r.body.cursor
      if (!cursor) break
    }
    return { out, pages }
  }
  const cases: Array<[string, (limit: string, cursor?: string) => Promise<Res>]> = [
    ["following (alice)", (limit, cursor) => getFeed(FIRST.following, alice, { limit, ...(cursor ? { cursor } : {}) })],
    ["timeline (alice)", async (limit, cursor) =>
      call(APPVIEW, Q.timeline, {
        params: { limit, ...(cursor ? { cursor } : {}) },
        auth: await token(alice, APPVIEW_DID, Q.timeline),
      })],
    ["jobs-for-you (tal-022)", (limit, cursor) => getFeed(FIRST.jobs, seeker, { limit, ...(cursor ? { cursor } : {}) })],
    ["industry-pulse (anonymous)", (limit, cursor) => getFeed(FIRST.pulse, undefined, { limit, ...(cursor ? { cursor } : {}) })],
    ["industry-pulse (alice)", (limit, cursor) => getFeed(FIRST.pulse, alice, { limit, ...(cursor ? { cursor } : {}) })],
  ]
  for (const [label, get] of cases) {
    const whole = uris(await get("100"))
    const { out: paged, pages } = await pageAll((c) => get("2", c))
    check(
      whole.length >= 2 && JSON.stringify(paged) === JSON.stringify(whole),
      `${label}: pages of 2 give the same ${whole.length} items, in order`,
      `${pages} requests, ${new Set(paged).size} unique`
    )
  }

  // ---------------------------------------------------------------------------
  section("web: pins, discovery and the feed pages")

  const web = async (path: string, body?: unknown) => {
    const r = await A!.web!.fetch(
      path,
      body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    )
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> }
  }
  const dir = await web("/api/feeds")
  check(
    dir.status === 200 && Object.values(FIRST).every((u) => dir.body.feeds.some((g: any) => g.uri === u)),
    "GET /api/feeds lists the first-party feeds",
    `${dir.body.feeds?.length} feeds`
  )
  const pin1 = await web("/api/feeds/pins", { feed: FIRST.pulse, pinned: true })
  const pin2 = await web("/api/feeds/pins", { feed: FIRST.communities, pinned: true })
  const pinned = await web("/api/feeds/pins")
  check(
    pin1.status === 200 && pin2.status === 200 &&
      pinned.body.feeds?.map((g: any) => g.uri).join() === [FIRST.pulse, FIRST.communities].join(),
    "A pins industry-pulse, then my-communities, through the web app; order kept",
    pinned.body.feeds?.map((g: any) => g.displayName).join(", ")
  )
  const pinnedRow = await db`select feeds from feed_pin where did = ${A!.did}`
  const repo = await call(PDS, "com.atproto.repo.describeRepo", { params: { repo: A!.did } })
  check(
    pinnedRow.length === 1 && !(repo.body.collections ?? []).some((c: string) => /pin|pref/i.test(c)),
    "pins are private AppView state: nothing about them is written to A's public repo",
    (repo.body.collections ?? []).join(", ")
  )
  const unknownPin = await web("/api/feeds/pins", { feed: `at://${A!.did}/${GENERATOR}/nope`, pinned: true })
  check(unknownPin.status === 400, "pinning a feed that does not exist → 400", unknownPin.body.error)
  const pinAnon = await fetch(`${WEB}/api/feeds/pins`)
  check(pinAnon.status === 401, "reading pins without a session → 401")
  const pinsDirect = await call(APPVIEW, Q.pinned)
  check(pinsDirect.status === 401, "the AppView's getPinnedFeeds without service auth → 401")
  const home = await A!.web!.fetch("/")
  const homeText = await home.text()
  check(
    home.status === 200 && homeText.includes("Industry pulse") && homeText.includes("My communities") && homeText.includes('data-testid="feed"'),
    "home shows the switcher with the pinned feeds, and the timeline"
  )
  const homePulse = await A!.web!.fetch(`/?feed=${encodeURIComponent(FIRST.pulse)}`)
  check(
    homePulse.status === 200 && (await homePulse.text()).includes("About this feed"),
    "selecting a pinned feed on home renders it"
  )
  const apiFeed = await web(`/api/feeds/feed?feed=${encodeURIComponent(FIRST.following)}&limit=3`)
  check(
    apiFeed.status === 200 &&
      apiFeed.body.ok &&
      apiFeed.body.entries.length > 0 &&
      apiFeed.body.entries.length <= 3 &&
      Boolean(apiFeed.body.cursor),
    "GET /api/feeds/feed pages a feed for the signed-in user (the “Load more” path)",
    // A page can come back short: the hidden post B wrote in section 5 is
    // in A's following skeleton, and the AppView withholds it.
    `${apiFeed.body.entries?.length} of 3 entries, cursor ${apiFeed.body.cursor ? "yes" : "no"}`
  )
  const unpin = await web("/api/feeds/pins", { feed: FIRST.pulse, pinned: false })
  check(
    unpin.status === 200 && unpin.body.feeds?.join() === FIRST.communities,
    "unpinning removes just that one"
  )
  const dirPage = await fetch(`${WEB}/feeds`)
  check(dirPage.status === 200 && (await dirPage.text()).includes("Jobs for you"), "/feeds renders the directory")

  // ---------------------------------------------------------------------------
  section("9. extensibility: a third-party generator, with no AppView or web change")

  const THIRD = process.env.THIRDPARTY_URL ?? "http://localhost:2586"
  const thirdEnv = await readEnv("apps/feedgen-thirdparty/.env.example")
  const thirdDid = thirdEnv.SERVICE_DID ?? "did:web:localhost%3A2586"
  const thirdPublisher = (
    await call(PDS, "com.atproto.identity.resolveHandle", {
      params: { handle: thirdEnv.PUBLISHER ?? "link-roundup.test" },
    })
  ).body.did as string
  const LINKS = `at://${thirdPublisher}/${GENERATOR}/with-links`
  const thirdDoc = await (await fetch(`${THIRD}/.well-known/did.json`)).json()
  check(
    thirdDoc.id === thirdDid &&
      thirdDoc.service?.[0]?.type === "AuthentiqFeedGenerator",
    "the third party serves its own did:web document",
    `${thirdDoc.id} → ${thirdDoc.service?.[0]?.serviceEndpoint}`
  )
  const discovered = await call(APPVIEW, Q.list, { params: { limit: "100" } })
  const thirdView = (discovered.body.feeds as Array<any>).find((g) => g.uri === LINKS)
  check(
    thirdView?.did === thirdDid && thirdView.creator.handle === thirdEnv.PUBLISHER,
    "discoverable: the AppView found its generator record on the firehose",
    `“${thirdView?.displayName}” by @${thirdView?.creator.handle}`
  )
  const dirHtml = await (await fetch(`${WEB}/feeds`)).text()
  check(dirHtml.includes("Posts with a link"), "…and /feeds lists it")

  // A posts with a link through the web composer; B posts a link card in P's
  // community and P hides it; D posts a link and then deactivates.
  const aLink = await web("/api/posts", {
    text: `Worth reading: https://example.com/third-party-${suffix}`,
  })
  const card = (uri: string) => ({
    $type: `${NS}.embed.external`,
    external: { uri, title: "A link card" },
  })
  const bLink = (
    await createRecord(B!, POST, post(`B's link ${suffix}`, {
      community: { uri: community.uri, cid: community.cid },
      embed: card(`https://example.com/b-${suffix}`),
    }))
  ).body.uri
  const dLink = (
    await createRecord(D!, POST, post(`D's link ${suffix}`, { embed: card(`https://example.com/d-${suffix}`) }))
  ).body.uri
  const noLink = (await createRecord(C!, POST, post(`C has no link ${suffix}`))).body.uri
  await Promise.all([bLink, dLink, noLink].map((u) => indexed("post", u)))
  const thirdSkeleton = async () =>
    new Set(
      (((await call(THIRD, Q.skeleton, { params: { feed: LINKS, limit: "100" } })).body.feed ?? []) as Array<any>).map(
        (i) => i.post as string
      )
    )
  const inSkeleton = await until(async () => {
    const s = await thirdSkeleton()
    return s.has(aLink.body.uri) && s.has(bLink) && s.has(dLink) ? s : undefined
  })
  check(
    aLink.status === 200 && Boolean(inSkeleton.value) && !inSkeleton.value?.has(noLink),
    "its skeleton picks up new posts with links from the firehose, and not the one without",
    took(inSkeleton)
  )
  const shown = await until(async () => {
    const r = await getFeed(LINKS, A!)
    return r.ok && uris(r).includes(aLink.body.uri) ? r : undefined
  })
  check(
    Boolean(shown.value),
    "served through getFeed, hydrated like any other feed (signed in; the AppView checks A's token for :2586)",
    `${uris(shown.value!).length} posts, ${took(shown)}`
  )
  const anonThird = await getFeed(LINKS)
  check(anonThird.ok && uris(anonThird).includes(aLink.body.uri), "…and anonymously")
  const linkItem = (shown.value!.body.feed as Array<any>).find((i) => i.post.uri === aLink.body.uri)
  check(
    linkItem?.post.author.did === A!.did && linkItem.post.record.facets?.length > 0,
    "the post comes back as a full postView (author, record, facets)"
  )
  await call(APPVIEW, Q.hide, {
    body: { community: community.uri, post: bLink },
    auth: await token(P!, APPVIEW_DID, Q.hide),
  })
  await call(PDS, "com.atproto.server.deactivateAccount", { body: {}, auth: D!.jwt })
  const filtered = await until(async () => {
    const r = await getFeed(LINKS)
    const u = uris(r)
    return r.ok && !u.includes(bLink) && !u.includes(dLink) ? r : undefined
  })
  const stillInSkeleton = await thirdSkeleton()
  check(
    Boolean(filtered.value) && stillInSkeleton.has(bLink) && stillInSkeleton.has(dLink),
    "policy-filtered like any other: the third party still lists the hidden post and the deactivated author's, and the AppView drops both",
    took(filtered)
  )
  const pinThird = await web("/api/feeds/pins", { feed: LINKS, pinned: true })
  const homeThird = await A!.web!.fetch(`/?feed=${encodeURIComponent(LINKS)}`)
  const homeThirdHtml = await homeThird.text()
  check(
    pinThird.status === 200 && pinThird.body.feeds.includes(LINKS) &&
      homeThirdHtml.includes("Posts with a link") &&
      homeThirdHtml.includes(`third-party-${suffix}`),
    "pinnable: A pins it, and home shows it in the switcher with A's post in it"
  )

  // Independence, statically: the third party's sources and dependencies.
  const thirdFiles = [...new Bun.Glob("apps/feedgen-thirdparty/{src,scripts}/**/*.ts").scanSync(root)]
  const sources = await Promise.all(thirdFiles.map((f) => Bun.file(join(root, f)).text()))
  const imports = [...new Set(sources.flatMap((t) => [...t.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!)))]
  const pkg = await Bun.file(join(root, "apps/feedgen-thirdparty/package.json")).json()
  check(
    imports.every((i) => i.startsWith("@atproto/") || i.startsWith(".") || i.startsWith("node:")) &&
      Object.keys(pkg.dependencies).every((d) => d.startsWith("@atproto/")),
    "it imports nothing of ours: only @atproto/* and its own files",
    imports.filter((i) => !i.startsWith(".")).join(", ")
  )
  check(
    !sources.some((t) => /DATABASE_URL|postgres|drizzle|:2584|:5442/.test(t)) &&
      !Object.keys(thirdEnv).some((k) => /DATABASE|APPVIEW/.test(k)),
    "it has no database, no AppView address and no shared secret in its code or config",
    Object.keys(thirdEnv).join(", ")
  )
  // The step's diff: from a tree recorded before the third party was added
  // to one recorded after it (or the working tree now). Trees, not commits.
  const base = process.env.THIRDPARTY_BASE
  if (base) {
    let now = process.env.THIRDPARTY_HEAD
    if (!now) {
      // The working tree as a tree object, via a throwaway index: no commit.
      const index = join(tmpdir(), `verify-feeds-${suffix}.index`)
      const gitEnv = { ...process.env, GIT_INDEX_FILE: index }
      await Bun.$`git read-tree HEAD`.env(gitEnv).cwd(root).quiet()
      await Bun.$`git add -A`.env(gitEnv).cwd(root).quiet()
      now = (await Bun.$`git write-tree`.env(gitEnv).cwd(root).text()).trim()
    }
    const changed = (await Bun.$`git diff --name-only ${base} ${now}`.cwd(root).text())
      .split("\n")
      .filter(Boolean)
    const allowed = (f: string) =>
      f.startsWith("apps/feedgen-thirdparty/") ||
      f.startsWith("infra/") ||
      f === "package.json" ||
      f === "bun.lock" ||
      f === "README.md" ||
      f.startsWith("docs/")
    check(
      changed.length > 0 &&
        changed.every(allowed) &&
        !changed.some((f) => f.startsWith("apps/appview/") || f.startsWith("apps/web/")),
      `from ${base.slice(0, 7)} to ${now.slice(0, 7)}, the step touched only its own directory, root scripts, infra and docs`,
      `${changed.length} files; apps/appview: ${changed.filter((f) => f.startsWith("apps/appview/")).length}, apps/web: ${changed.filter((f) => f.startsWith("apps/web/")).length}`
    )
  } else {
    note(
      "git diff for the third-party step skipped",
      "set THIRDPARTY_BASE=<tree> (and THIRDPARTY_HEAD=<tree>) to check it"
    )
  }
} catch (err) {
  failures++
  console.log(`✗ ${(err as Error).stack ?? (err as Error).message}`)
} finally {
  section("cleanup")
  scripted.stop(true)
  for (const s of docServers) s.stop(true)
  for (const c of canaries) c.stop(true)
  let removed = 0
  for (const a of accounts) {
    const res = await call(PDS, "com.atproto.admin.deleteAccount", {
      body: { did: a.did },
      auth: PDS_ADMIN,
    })
    if (res.ok) removed++
  }
  const gone = await until(async () => {
    const [row] =
      await db`select count(*)::int as n from actor where did in ${db(accounts.map((a) => a.did))}`
    return row.n === 0
  })
  // The third party has no database of ours to cascade: it learns about the
  // deletions from the firehose's #account events.
  const dids = new Set(accounts.map((a) => a.did))
  const thirdClean = await until(async () => {
    const r = await call(process.env.THIRDPARTY_URL ?? "http://localhost:2586", Q.skeleton, {
      params: {
        feed: `at://${(await call(PDS, "com.atproto.identity.resolveHandle", { params: { handle: "link-roundup.test" } })).body.did}/${GENERATOR}/with-links`,
        limit: "100",
      },
    })
    return r.ok && !(r.body.feed as Array<any>).some((i) => dids.has(i.post.split("/")[2]))
  })
  check(
    Boolean(thirdClean.value),
    "the third party drops the deleted accounts' posts too, from the firehose",
    took(thirdClean)
  )
  const [pinsLeft] =
    await db`select count(*)::int as n from feed_pin where did in ${db(accounts.map((a) => a.did))}`
  check(
    removed === accounts.length && Boolean(gone.value) && pinsLeft.n === 0,
    `${removed} throwaway account(s) deleted, with their records, feeds and pins`,
    took(gone)
  )
  await db.close()
}

console.log(
  failures
    ? `\n${failures} check(s) failed, ${passes} passed`
    : `\nall ${passes} checks passed`
)
process.exit(failures ? 1 : 0)
