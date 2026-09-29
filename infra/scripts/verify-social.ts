/**
 * End-to-end check of the phase 6 social layer, against the live stack:
 *
 *   web BFF / PDS write → firehose → indexer rules → Postgres → AppView views
 *
 * Works on four throwaway accounts (`sa-…`, `sb-…`, `sc-…`, `sd-…`) that it
 * deletes at the end. Writes that test the AppView go straight to the PDS;
 * writes that test the BFF (facets at compose time, likes, follows,
 * communities, hiding) go through the web app's API routes over a real
 * OAuth session. Needs `bun run dev` and ADMIN_TOKEN in apps/appview/.env
 * (the out-of-order check stops the indexer and backfills repos by hand).
 * Every wait is a poll with a timeout.
 *
 *   bun run verify:social
 */
import { join } from "node:path"
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

const PDS = process.env.PDS_URL ?? LOCAL_NETWORK.pdsUrl
const APPVIEW = process.env.APPVIEW_URL ?? LOCAL_NETWORK.appviewUrl
const WEB = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000"
const APPVIEW_DID = appviewEnv.SERVICE_DID ?? "did:web:localhost%3A2584"
const ADMIN_TOKEN = appviewEnv.ADMIN_TOKEN ?? ""
const PDS_ADMIN = `Basic ${btoa(`admin:${infraEnv.PDS_ADMIN_PASSWORD}`)}`
const TIMEOUT_MS = 10_000

const NS = "sh.authentiq"
const POST = `${NS}.feed.post`
const LIKE = `${NS}.feed.like`
const FOLLOW = `${NS}.graph.follow`
const DECLARATION = `${NS}.community.declaration`
const MEMBERSHIP = `${NS}.community.membership`
const Q = {
  thread: `${NS}.feed.getPostThread`,
  authorFeed: `${NS}.feed.getAuthorFeed`,
  list: `${NS}.community.list`,
  community: `${NS}.community.getCommunity`,
  posts: `${NS}.community.getPosts`,
  hide: `${NS}.community.hidePost`,
  unhide: `${NS}.community.unhidePost`,
  profile: `${NS}.actor.getProfile`,
}

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
const section = (title: string) => console.log(`\n${title}`)

async function until<T>(probe: () => Promise<T | undefined | null | false>) {
  const started = performance.now()
  while (performance.now() - started < TIMEOUT_MS) {
    const value = await probe().catch(() => undefined)
    if (value) return { value, ms: Math.round(performance.now() - started) }
    await Bun.sleep(50)
  }
  return { value: undefined, ms: TIMEOUT_MS }
}
const took = (r: { value: unknown; ms: number }) =>
  r.value ? `${r.ms} ms` : `timed out after ${TIMEOUT_MS} ms`

type Res = { status: number; ok: boolean; body: Record<string, any> }

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
  const res = await fetch(url, {
    method: opts.body === undefined && !opts.post ? "GET" : "POST",
    headers: {
      ...(opts.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, any>
  return { status: res.status, ok: res.ok, body }
}

async function admin(path: string, body?: unknown) {
  const res = await fetch(new URL(`/_admin/${path}`, APPVIEW), {
    method: body === undefined && !path.includes("/") ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, any>,
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
  const handle = `s${name}-${suffix}.test`
  const res = await call(PDS, "com.atproto.server.createAccount", {
    body: {
      handle,
      email: `s${name}-${suffix}@authentiq.test`,
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

/** A single-use service auth token for one AppView method, as the BFF gets. */
async function token(a: Account, lxm: string) {
  const res = await call(PDS, "com.atproto.server.getServiceAuth", {
    params: {
      aud: APPVIEW_DID,
      lxm,
      exp: String(Math.floor(Date.now() / 1000) + 60),
    },
    auth: a.jwt,
  })
  if (!res.ok) throw new Error(`getServiceAuth: ${res.body.message}`)
  return `Bearer ${res.body.token}`
}

/** An AppView query, anonymously or as `viewer`. */
async function av(
  lxm: string,
  params: Record<string, string>,
  viewer?: Account
) {
  return call(APPVIEW, lxm, {
    params,
    auth: viewer ? await token(viewer, lxm) : undefined,
  })
}

const create = (
  a: Account,
  collection: string,
  record: Record<string, unknown>
) =>
  call(PDS, "com.atproto.repo.createRecord", {
    body: { repo: a.did, collection, record },
    auth: a.jwt,
  })
const put = (a: Account, collection: string, rkey: string, record: unknown) =>
  call(PDS, "com.atproto.repo.putRecord", {
    body: { repo: a.did, collection, rkey, record },
    auth: a.jwt,
  })
const remove = (a: Account, uri: string) =>
  call(PDS, "com.atproto.repo.deleteRecord", {
    body: {
      repo: a.did,
      collection: uri.split("/")[3],
      rkey: uri.split("/")[4],
    },
    auth: a.jwt,
  })
const getRecord = (uri: string) =>
  call(PDS, "com.atproto.repo.getRecord", {
    params: {
      repo: uri.split("/")[2]!,
      collection: uri.split("/")[3]!,
      rkey: uri.split("/")[4]!,
    },
  })

const now = () => new Date().toISOString()
type Ref = { uri: string; cid: string }
const ref = (r: Res): Ref => ({ uri: r.body.uri, cid: r.body.cid })
const postRecord = (text: string, extra: Record<string, unknown> = {}) => ({
  $type: POST,
  text,
  createdAt: now(),
  ...extra,
})
const reply = (rootRef: Ref, parent: Ref) => ({
  reply: { root: rootRef, parent },
})
async function writePost(a: Account, text: string, extra = {}) {
  const res = await create(a, POST, postRecord(text, extra))
  if (!res.ok) throw new Error(`createRecord: ${res.body.message}`)
  return ref(res)
}

/** A web API route, as the browser calls it, with the account's session. */
async function web(a: Account, path: string, body: unknown) {
  const res = await a.web!.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return {
    status: res.status,
    ok: res.ok,
    body: (await res.json().catch(() => ({}))) as Record<string, any>,
  }
}

const indexedPost = async (uri: string) =>
  (await db`select uri, cid, text from post where uri = ${uri}`)[0]
const thread = (uri: string, viewer?: Account) => av(Q.thread, { uri }, viewer)
const feedUris = (r: Res) =>
  ((r.body.feed ?? []) as Array<any>).map((f) => f.post.uri as string)
const kindOf = (n: any) =>
  n?.$type?.split("#")[1] as
    "threadViewPost" | "notFoundPost" | "hiddenPost" | undefined
const uriOf = (n: any) => (n?.post?.uri ?? n?.uri) as string | undefined

/** Every key anywhere in a JSON value. */
function keysOf(v: unknown, out = new Set<string>()) {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out)
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.add(k)
      keysOf(x, out)
    }
  return out
}

// --- 0. preconditions --------------------------------------------------------------

const health = await fetch(new URL("/xrpc/_health", APPVIEW)).catch(() => null)
if (!health?.ok) {
  console.log(
    `✗ AppView not reachable at ${APPVIEW} (start it with \`bun run dev\`)`
  )
  process.exit(1)
}
if ((await admin("indexer")).status !== 200) {
  console.log(
    "✗ /_admin/indexer refused — is ADMIN_TOKEN set in apps/appview/.env?"
  )
  process.exit(1)
}

let stoppedIndexer = false
try {
  const [A, B, C, D] = [
    await createAccount("a"),
    await createAccount("b"),
    await createAccount("c"),
    await createAccount("d"),
  ]
  check(
    true,
    "four throwaway accounts created on the PDS",
    accounts.map((a) => a.handle).join(", ")
  )
  // First sight of each repo triggers a backfill; let that settle.
  for (const a of accounts) {
    await writePost(a, `hello from ${a.handle}`)
  }
  const seen = await until(async () => {
    const [row] = await db`
      select count(*)::int as n from actor
      where did in ${db(accounts.map((a) => a.did))} and backfilled_at is not null`
    return row.n === accounts.length
  })
  check(Boolean(seen.value), "the indexer has seen all four repos", took(seen))
  for (const a of [A, B]) {
    a.web = await signInToWeb({
      web: WEB,
      pds: PDS,
      handle: a.handle,
      password: "password",
    })
  }
  check(true, "A and B signed in to the web app over OAuth")

  // --- 1. a post's lifecycle ----------------------------------------------------------
  section("1. write → getAuthorFeed and getPostThread; edits ignored; delete")

  const p1 = await writePost(A, `Probe post ${suffix}`)
  const inFeed = await until(async () =>
    feedUris(await av(Q.authorFeed, { actor: A.handle })).includes(p1.uri)
  )
  check(
    Boolean(inFeed.value),
    "a post written to the PDS appears in getAuthorFeed",
    took(inFeed)
  )
  const t1 = await thread(p1.uri)
  check(
    kindOf(t1.body.thread) === "threadViewPost" &&
      t1.body.thread.post.record.text === `Probe post ${suffix}`,
    "getPostThread serves it",
    kindOf(t1.body.thread)
  )

  const edit = await put(
    A,
    POST,
    p1.uri.split("/")[4]!,
    postRecord("EDITED text")
  )
  check(
    edit.ok,
    "the PDS accepts an edit (putRecord) to the post",
    edit.body.validationStatus
  )
  const afterEdit = await writePost(A, `sentinel after edit ${suffix}`)
  await until(() => indexedPost(afterEdit.uri))
  const kept = await indexedPost(p1.uri)
  check(
    kept?.text === `Probe post ${suffix}` && kept?.cid === p1.cid,
    "the edit is ignored: posts are create-only, the published version stays",
    `text “${kept?.text}”, cid unchanged: ${kept?.cid === p1.cid}`
  )

  await remove(A, p1.uri)
  const gone = await until(
    async () => (await thread(p1.uri)).body.error === "NotFound"
  )
  check(
    Boolean(gone.value),
    "deleting it removes it from getPostThread",
    took(gone)
  )
  check(
    !feedUris(await av(Q.authorFeed, { actor: A.handle })).includes(p1.uri),
    "and from getAuthorFeed"
  )

  // --- 2. a three-level thread ----------------------------------------------------------
  section("2. three-level thread; deleting the middle leaves a placeholder")

  const r0 = await writePost(
    A,
    "Thread root: what makes an on-call rotation humane?"
  )
  const r1 = await writePost(
    B,
    "Level 1: alerts that name a user-visible symptom.",
    reply(r0, r0)
  )
  const r2 = await writePost(
    C,
    "Level 2: and a digest for everything else.",
    reply(r0, r1)
  )
  const assembled = await until(async () => {
    const t = (await thread(r0.uri)).body.thread
    return uriOf(t?.replies?.[0]) === r1.uri &&
      uriOf(t.replies[0].replies?.[0]) === r2.uri
      ? t
      : undefined
  })
  check(
    Boolean(assembled.value),
    "getPostThread(root) nests root → level 1 → level 2",
    took(assembled)
  )
  check(
    assembled.value?.post.replyCount === 1 &&
      assembled.value?.replies[0].post.replyCount === 1,
    "reply counts are direct replies (navigation)",
    `root ${assembled.value?.post.replyCount}, level 1 ${assembled.value?.replies[0].post.replyCount}`
  )
  const up = (await thread(r2.uri)).body.thread
  check(
    uriOf(up.parent) === r1.uri && uriOf(up.parent?.parent) === r0.uri,
    "getPostThread(level 2) walks up to the root"
  )

  await remove(B, r1.uri)
  const holed = await until(async () => {
    const t = (await thread(r0.uri)).body.thread
    const mid = t?.replies?.[0]
    return kindOf(mid) === "notFoundPost" &&
      mid.uri === r1.uri &&
      uriOf(mid.replies?.[0]) === r2.uri
      ? t
      : undefined
  })
  check(
    Boolean(holed.value),
    "after deleting level 1, a not-found placeholder keeps level 2 under the root",
    took(holed)
  )
  const upAfter = (await thread(r2.uri)).body.thread
  check(
    kindOf(upAfter.parent) === "notFoundPost" && upAfter.parent.uri === r1.uri,
    "and level 2's parent is the placeholder"
  )

  // --- 3. out of order -----------------------------------------------------------------
  section(
    "3. out-of-order indexing (indexer stopped, reply's repo backfilled first)"
  )

  const stopped = await admin("indexer/stop")
  stoppedIndexer = true
  check(stopped.body.running === false, "indexer stopped")
  const op = await writePost(A, "Out-of-order parent, in A's repo")
  const oq = await writePost(
    B,
    "Out-of-order reply, in B's repo",
    reply(op, op)
  )
  const ol = await create(C, LIKE, {
    $type: LIKE,
    subject: op,
    createdAt: now(),
  })
  check(
    !(await indexedPost(op.uri)) && !(await indexedPost(oq.uri)),
    "neither is indexed while the indexer is stopped"
  )
  await admin("backfill", { did: B.did })
  await admin("backfill", { did: C.did })
  check(
    Boolean(await indexedPost(oq.uri)) && !(await indexedPost(op.uri)),
    "backfilling B's repo first indexes the reply without its parent"
  )
  const early = (await thread(oq.uri)).body.thread
  check(
    kindOf(early) === "threadViewPost" &&
      kindOf(early.parent) === "notFoundPost" &&
      early.parent.uri === op.uri,
    "the reply's thread shows a placeholder for the parent that has not arrived"
  )
  check(
    (await thread(op.uri)).body.error === "NotFound",
    "the parent itself is not found yet"
  )
  await admin("backfill", { did: A.did })
  const late = (await thread(op.uri)).body.thread
  check(
    uriOf(late?.replies?.[0]) === oq.uri && late.post.replyCount === 1,
    "once A's repo is backfilled, the parent's thread includes the reply"
  )
  check(
    uriOf((await thread(oq.uri)).body.thread.parent) === op.uri,
    "and the reply's parent resolves to the real post"
  )
  check(
    Boolean(
      (await thread(op.uri, C)).body.thread?.post.viewer?.like === ol.body.uri
    ),
    "a like indexed before its post shows as viewer state once the post is in"
  )
  const started = await admin("indexer/start")
  stoppedIndexer = false
  check(
    started.body.running === true,
    "indexer restarted; the firehose replays those commits"
  )
  const afterRestart = await writePost(B, `sentinel after restart ${suffix}`)
  await until(() => indexedPost(afterRestart.uri))
  const [dupes] =
    await db`select count(*)::int as n from post where uri in ${db([op.uri, oq.uri])}`
  const stillRight = (await thread(op.uri)).body.thread
  check(
    dupes.n === 2 &&
      stillRight.replies?.length === 1 &&
      uriOf(stillRight.replies[0]) === oq.uri,
    "the replay changes nothing: same two posts, same thread"
  )

  // --- 4. facets -----------------------------------------------------------------------
  section("4. facets with emoji and Arabic, written through the web composer")

  const url = "https://example.com/jobs?role=payments"
  const text = `مرحبا 👋🏽 @${B.handle} انظر ${url} 👨‍👩‍👧 شكراً`
  const composed = await web(A, "/api/posts", { text })
  check(
    composed.ok,
    "POST /api/posts as A",
    `${composed.status} ${composed.body.uri ?? composed.body.message}`
  )
  const stored = (await getRecord(composed.body.uri)).body.value
  const bytes = new TextEncoder().encode(text)
  const slice = (f: any) =>
    new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd))
  const mention = stored?.facets?.find(
    (f: any) => f.features[0].$type === `${NS}.richtext.facet#mention`
  )
  const link = stored?.facets?.find(
    (f: any) => f.features[0].$type === `${NS}.richtext.facet#link`
  )
  check(
    mention?.features[0].did === B.did,
    "the mention was resolved to B's DID at compose time",
    mention?.features[0].did
  )
  check(
    slice(mention ?? { index: { byteStart: 0, byteEnd: 0 } }) ===
      `@${B.handle}`,
    "its UTF-8 byte range covers exactly the @handle",
    `bytes ${mention?.index.byteStart}–${mention?.index.byteEnd} → “${mention ? slice(mention) : ""}”`
  )
  check(
    link?.features[0].uri === url && slice(link) === url,
    "the link's byte range covers exactly the URL",
    `bytes ${link?.index.byteStart}–${link?.index.byteEnd}`
  )
  check(
    mention?.index.byteStart !== text.indexOf("@"),
    "offsets are bytes, not UTF-16 indices",
    `@ is UTF-16 index ${text.indexOf("@")}, byte ${mention?.index.byteStart}`
  )
  const viewed = (await thread(composed.body.uri)).body.thread?.post.record
  check(
    JSON.stringify(viewed?.facets) === JSON.stringify(stored?.facets),
    "the AppView serves the same facets"
  )
  const max = "ب👋🏽".repeat(1500)
  const atLimit = await web(A, "/api/posts", { text: max })
  check(
    atLimit.ok,
    "3000 graphemes of Arabic and emoji are accepted (4500 UTF-16 units, 15000 bytes)",
    `${atLimit.status}`
  )
  const overLimit = await web(A, "/api/posts", { text: `${max}x` })
  check(
    overLimit.status === 400,
    "3001 graphemes are refused by the web schema",
    `${overLimit.status} ${overLimit.body.message}`
  )

  // --- 5. invalid records ----------------------------------------------------------------
  section("5. invalid records: accepted by the PDS, never indexed")

  const other = await writePost(A, "another post, for a second CID")
  const community = ref(
    await create(A, DECLARATION, {
      $type: DECLARATION,
      name: `Verify ${suffix}`,
      topic: "Verification",
      createdAt: now(),
    })
  )
  const invalid: Record<string, { res: Res; table: string }> = {
    "text of 3001 graphemes": {
      res: await create(A, POST, postRecord("a".repeat(3001))),
      table: "post",
    },
    "text over 30000 bytes (2000 emoji families)": {
      res: await create(A, POST, postRecord("👨‍👩‍👧".repeat(2000))),
      table: "post",
    },
    "blank text": {
      res: await create(A, POST, postRecord("  \n ")),
      table: "post",
    },
    "a facet range outside the text": {
      res: await create(
        A,
        POST,
        postRecord("hello", {
          facets: [
            {
              index: { byteStart: 2, byteEnd: 50 },
              features: [
                {
                  $type: `${NS}.richtext.facet#link`,
                  uri: "https://example.com",
                },
              ],
            },
          ],
        })
      ),
      table: "post",
    },
    "a facet that splits an Arabic letter": {
      res: await create(
        A,
        POST,
        postRecord("مرحبا", {
          facets: [
            {
              index: { byteStart: 1, byteEnd: 4 },
              features: [{ $type: `${NS}.richtext.facet#mention`, did: B.did }],
            },
          ],
        })
      ),
      table: "post",
    },
    "a reply whose root and parent disagree (same post, different CIDs)": {
      res: await create(
        A,
        POST,
        postRecord("bad reply", reply(r0, { uri: r0.uri, cid: other.cid }))
      ),
      table: "post",
    },
    "a reply whose parent is not a post": {
      res: await create(A, POST, postRecord("bad reply", reply(r0, community))),
      table: "post",
    },
    "a reply that sets its own community": {
      res: await create(
        A,
        POST,
        postRecord("bad reply", { ...reply(r0, r0), community })
      ),
      table: "post",
    },
    "a self-follow": {
      res: await create(A, FOLLOW, {
        $type: FOLLOW,
        subject: A.did,
        createdAt: now(),
      }),
      table: "follow",
    },
    "a like of something that is not a post": {
      res: await create(A, LIKE, {
        $type: LIKE,
        subject: community,
        createdAt: now(),
      }),
      table: "post_like",
    },
    "a membership of something that is not a community": {
      res: await create(A, MEMBERSHIP, {
        $type: MEMBERSHIP,
        community: other,
        createdAt: now(),
      }),
      table: "membership",
    },
  }
  for (const [label, { res }] of Object.entries(invalid)) {
    check(
      res.ok && res.body.validationStatus === "unknown",
      `PDS accepts ${label}`,
      res.body.validationStatus ?? res.body.message
    )
  }
  // Events for one repo are processed in order: once this is in, the
  // invalid records before it have been seen and dropped.
  const sentinel = await writePost(A, `valid sentinel ${suffix}`)
  const sentinelIn = await until(() => indexedPost(sentinel.uri))
  check(
    Boolean(sentinelIn.value),
    "a later valid post is indexed",
    took(sentinelIn)
  )
  let leaked = 0
  for (const { res, table } of Object.values(invalid)) {
    const rows = await db.unsafe(`select 1 from ${table} where uri = $1`, [
      res.body.uri,
    ])
    leaked += rows.length
  }
  check(
    leaked === 0,
    "none of the invalid records reached the index",
    `${leaked} leaked`
  )

  // Disagreement that only shows once both posts are in: root is one
  // thread's, parent is another thread's. Valid alone, so indexed; never
  // placed in either thread.
  const crossed = await writePost(C, "crossed reply", reply(r0, op))
  await until(() => indexedPost(crossed.uri))
  const inR0 = JSON.stringify((await thread(r0.uri)).body).includes(crossed.uri)
  const inOp = JSON.stringify((await thread(op.uri)).body).includes(crossed.uri)
  check(
    !inR0 && !inOp && (await thread(op.uri)).body.thread.post.replyCount === 1,
    "a reply whose root and parent belong to different threads is shown in neither",
    "checked when the thread is built, since the parent may arrive later"
  )

  // --- 6. likes, follows, and no counts -------------------------------------------------------
  section(
    "6. like/unlike and follow/unfollow change viewer state; no counts anywhere"
  )

  const liked = await web(B, "/api/likes", { subject: r0.uri })
  check(liked.ok, "B likes A's post through the web app", liked.body.uri)
  const likeShown = await until(
    async () =>
      (await thread(r0.uri, B)).body.thread?.post.viewer?.like ===
      liked.body.uri
  )
  check(
    Boolean(likeShown.value),
    "B sees viewer.like on the post",
    took(likeShown)
  )
  check(
    (await thread(r0.uri, A)).body.thread.post.viewer?.like === undefined,
    "A (who did not like it) sees no like, and no count"
  )
  await web(B, "/api/records/delete", { uri: liked.body.uri })
  const unliked = await until(
    async () =>
      (await thread(r0.uri, B)).body.thread?.post.viewer?.like === undefined
  )
  check(Boolean(unliked.value), "unlike removes it", took(unliked))

  const followed = await web(B, "/api/follows", { subject: A.handle })
  check(
    followed.ok,
    "B follows A through the web app (by handle)",
    followed.body.uri
  )
  const following = await until(
    async () =>
      (await av(Q.profile, { actor: A.handle }, B)).body.viewer?.following ===
      followed.body.uri
  )
  check(
    Boolean(following.value),
    "getProfile(A) as B says B follows A",
    took(following)
  )
  const selfFollow = await web(B, "/api/follows", { subject: B.did })
  check(
    selfFollow.status === 400,
    "the web app refuses a self-follow",
    `${selfFollow.status}`
  )
  await web(B, "/api/records/delete", { uri: followed.body.uri })
  const unfollowed = await until(
    async () =>
      (await av(Q.profile, { actor: A.handle }, B)).body.viewer?.following ===
      undefined
  )
  check(Boolean(unfollowed.value), "unfollow removes it", took(unfollowed))

  // Three likes and a follow, so any count would be non-zero.
  await web(B, "/api/likes", { subject: r0.uri })
  await create(C, LIKE, { $type: LIKE, subject: r0, createdAt: now() })
  await create(D, LIKE, { $type: LIKE, subject: r0, createdAt: now() })
  await create(C, FOLLOW, { $type: FOLLOW, subject: A.did, createdAt: now() })
  await until(async () => {
    const [row] =
      await db`select count(*)::int as n from post_like where subject_uri = ${r0.uri}`
    return row.n >= 3
  })
  const views = {
    getPostThread: await thread(r0.uri, B),
    getAuthorFeed: await av(Q.authorFeed, { actor: A.handle }, B),
    "getAuthorFeed (anonymous)": await av(Q.authorFeed, { actor: A.handle }),
    getProfile: await av(Q.profile, { actor: A.handle }, B),
    "community.list": await av(Q.list, {}, B),
    "community.getCommunity": await av(Q.community, { uri: community.uri }, B),
    "community.getPosts": await av(Q.posts, { community: community.uri }, B),
  }
  const countKeys = new Set<string>()
  for (const r of Object.values(views))
    for (const k of keysOf(r.body))
      if (/count/i.test(k) && k !== "replyCount") countKeys.add(k)
  check(
    countKeys.size === 0,
    "no like, follower, following or member count in any view",
    countKeys.size
      ? [...countKeys].join(", ")
      : `${Object.keys(views).length} views scanned; the only count is replyCount`
  )

  // --- 7. communities ----------------------------------------------------------------------
  section("7. community flow: create, join, post, leave; non-member policy")

  const made = await web(A, "/api/communities", {
    name: `Verify Guild ${suffix}`,
    topic: "Verification",
    description: "A community made by verify:social",
    rules: "Be kind\nStay on topic",
  })
  const guild = made.body.uri as string
  check(
    made.ok && made.body.indexed,
    "A creates a community through the web app",
    guild
  )
  const guildView = (await av(Q.community, { uri: guild }, A)).body
  check(
    guildView.viewer?.isCreator === true && guildView.rules?.length === 2,
    "getCommunity shows it, with A as creator"
  )
  check(
    (
      (await av(Q.list, { topic: "verification" })).body
        .communities as Array<any>
    ).some((c) => c.uri === guild),
    "community.list finds it by topic"
  )

  const early7 = await web(B, "/api/posts", {
    text: "Posting before joining",
    community: guild,
  })
  check(
    early7.status === 403,
    "the web app refuses B's post before B joins",
    `${early7.status} ${early7.body.error}`
  )
  const joined = await web(B, "/api/communities/join", { community: guild })
  check(
    joined.ok && joined.body.indexed,
    "B joins through the web app",
    joined.body.uri
  )
  const bPost = await web(B, "/api/posts", {
    text: `B's thread in the guild ${suffix}`,
    community: guild,
  })
  check(bPost.ok, "B posts into the community")
  const bShown = await until(async () => {
    const r = await av(Q.posts, { community: guild })
    return r.body.feed?.find((f: any) => f.post.uri === bPost.body.uri)
  })
  check(
    bShown.value?.post.community?.uri === guild,
    "community.getPosts lists it, labelled with the community",
    took(bShown)
  )

  // D never joined: written straight to the PDS, as another client might.
  const dPost = await writePost(D, `D's non-member post ${suffix}`, {
    community: { uri: guild, cid: made.body.cid },
  })
  await until(() => indexedPost(dPost.uri))
  check(
    !feedUris(await av(Q.posts, { community: guild })).includes(dPost.uri),
    "a non-member's post is indexed but not shown in the community"
  )
  const dFeedItem = (
    await av(Q.authorFeed, { actor: D.handle })
  ).body.feed?.find((f: any) => f.post.uri === dPost.uri)
  check(
    Boolean(dFeedItem) && dFeedItem.post.community === undefined,
    "it is on D's own profile, without the community label"
  )
  const dJoin = await create(D, MEMBERSHIP, {
    $type: MEMBERSHIP,
    community: { uri: guild, cid: made.body.cid },
    createdAt: now(),
  })
  const dShown = await until(async () =>
    feedUris(await av(Q.posts, { community: guild })).includes(dPost.uri)
  )
  check(
    Boolean(dShown.value),
    "once D's membership arrives, the earlier post appears (checked at read time)",
    took(dShown)
  )

  await web(B, "/api/records/delete", { uri: joined.body.uri })
  const bGone = await until(
    async () =>
      !feedUris(await av(Q.posts, { community: guild })).includes(
        bPost.body.uri
      )
  )
  check(
    Boolean(bGone.value),
    "B leaves; B's thread leaves the community with them",
    took(bGone)
  )
  check(
    (await av(Q.community, { uri: guild }, B)).body.viewer?.membership ===
      undefined,
    "B's viewer state no longer shows a membership"
  )

  // --- 8. hiding --------------------------------------------------------------------------
  section("8. the creator hides and unhides; nobody else can")

  const aPost = await web(A, "/api/posts", {
    text: `A's thread ${suffix}`,
    community: guild,
  })
  const aRef = { uri: aPost.body.uri as string, cid: aPost.body.cid as string }
  const dReply = await writePost(
    D,
    "D replies in A's thread",
    reply(aRef, aRef)
  )
  await until(
    async () => (await thread(aRef.uri)).body.thread?.replies?.length === 1
  )

  const hid = await web(A, "/api/communities/hide", {
    community: guild,
    post: dPost.uri,
    hidden: true,
  })
  check(
    hid.ok && hid.body.hidden === true,
    "A hides D's post through the web app"
  )
  check(
    !feedUris(await av(Q.posts, { community: guild })).includes(dPost.uri),
    "it is gone from community.getPosts"
  )
  check(
    kindOf((await thread(dPost.uri)).body.thread) === "hiddenPost",
    "its thread shows a hidden placeholder"
  )
  check(
    !feedUris(await av(Q.authorFeed, { actor: D.handle })).includes(dPost.uri),
    "and it is left out of D's author feed"
  )
  const hidReply = await web(A, "/api/communities/hide", {
    community: guild,
    post: dReply.uri,
    hidden: true,
  })
  const tA = (await thread(aRef.uri)).body.thread
  check(
    hidReply.ok &&
      kindOf(tA.replies?.[0]) === "hiddenPost" &&
      tA.replies[0].uri === dReply.uri,
    "a hidden reply is a placeholder in its thread"
  )
  check(
    tA.post.replyCount === 0,
    "and is not counted as a reply",
    `replyCount ${tA.post.replyCount}`
  )

  const byB = await web(B, "/api/communities/hide", {
    community: guild,
    post: aRef.uri,
    hidden: true,
  })
  check(
    byB.status === 403 && byB.body.error === "NotCommunityCreator",
    "B's hide call through the web app is rejected",
    `${byB.status} ${byB.body.error}`
  )
  const byBDirect = await call(APPVIEW, Q.hide, {
    body: { community: guild, post: aRef.uri },
    auth: await token(B, Q.hide),
  })
  check(
    byBDirect.status === 403,
    "B's hide call straight to the AppView, with B's own valid token, is rejected",
    `${byBDirect.status} ${byBDirect.body.error}`
  )
  const anon = await call(APPVIEW, Q.hide, {
    body: { community: guild, post: aRef.uri },
  })
  check(
    anon.status === 401,
    "an unauthenticated AppView call is rejected",
    `${anon.status} ${anon.body.error}`
  )
  const wrongLxm = await call(APPVIEW, Q.hide, {
    body: { community: guild, post: aRef.uri },
    auth: await token(A, Q.unhide),
  })
  check(
    wrongLxm.status === 401,
    "A's token for another method is rejected",
    `${wrongLxm.status} ${wrongLxm.body.error}`
  )
  const anonWeb = await fetch(`${WEB}/api/communities/hide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ community: guild, post: aRef.uri, hidden: true }),
  })
  check(
    anonWeb.status === 401,
    "an unauthenticated web call is rejected",
    `${anonWeb.status}`
  )
  const outside = await web(A, "/api/communities/hide", {
    community: guild,
    post: r0.uri,
    hidden: true,
  })
  check(
    outside.status === 400 && outside.body.error === "NotInCommunity",
    "A cannot hide a post outside the community",
    `${outside.status} ${outside.body.error}`
  )
  const inRepo = [await getRecord(dPost.uri), await getRecord(dReply.uri)]
  check(
    inRepo.every((r) => r.ok && r.body.value?.text),
    "the hidden posts are still in D's repo",
    "com.atproto.repo.getRecord returns both"
  )

  await web(A, "/api/communities/hide", {
    community: guild,
    post: dPost.uri,
    hidden: false,
  })
  await web(A, "/api/communities/hide", {
    community: guild,
    post: dReply.uri,
    hidden: false,
  })
  check(
    feedUris(await av(Q.posts, { community: guild })).includes(dPost.uri) &&
      kindOf((await thread(aRef.uri)).body.thread.replies?.[0]) ===
        "threadViewPost",
    "unhiding restores both"
  )

  // --- 9. deactivation ------------------------------------------------------------------------
  section(
    "9. deactivating an account hides its posts, likes, follows and memberships"
  )

  const dLike = await create(D, LIKE, {
    $type: LIKE,
    subject: aRef,
    createdAt: now(),
  })
  const dFollow = await create(D, FOLLOW, {
    $type: FOLLOW,
    subject: A.did,
    createdAt: now(),
  })
  const dCommunity = ref(
    await create(D, DECLARATION, {
      $type: DECLARATION,
      name: `D's club ${suffix}`,
      topic: "Verification",
      createdAt: now(),
    })
  )
  const before = await until(async () => {
    const t = (await thread(aRef.uri, D)).body.thread
    const p = (await av(Q.profile, { actor: A.handle }, D)).body
    const c = (await av(Q.community, { uri: guild }, D)).body
    return (
      t?.post.viewer?.like === dLike.body.uri &&
      p.viewer?.following === dFollow.body.uri &&
      c.viewer?.membership === dJoin.body.uri &&
      (await av(Q.community, { uri: dCommunity.uri })).ok
    )
  })
  check(
    Boolean(before.value),
    "before: D's like, follow, membership and community are all visible",
    took(before)
  )
  // Tokens minted while D is active, used after deactivation, so the
  // AppView is asked as D itself.
  const dTokens = {
    thread: await token(D, Q.thread),
    profile: await token(D, Q.profile),
    community: await token(D, Q.community),
  }
  const deactivated = await call(PDS, "com.atproto.server.deactivateAccount", {
    body: {},
    auth: D.jwt,
  })
  const hidden = await until(
    async () =>
      (await av(Q.authorFeed, { actor: D.handle })).body.error ===
      "ActorNotFound"
  )
  check(
    deactivated.ok && Boolean(hidden.value),
    "D deactivates; getAuthorFeed(D) → ActorNotFound",
    took(hidden)
  )
  check(
    !feedUris(await av(Q.posts, { community: guild })).includes(dPost.uri),
    "D's community post is gone from the community"
  )
  const tDeact = (await thread(aRef.uri)).body.thread
  check(
    kindOf(tDeact.replies?.[0]) === "notFoundPost" &&
      tDeact.post.replyCount === 0,
    "D's reply is a not-found placeholder, and not counted"
  )
  check(
    (await thread(dPost.uri)).body.error === "NotFound",
    "D's post page is not found"
  )
  check(
    (await av(Q.community, { uri: dCommunity.uri })).body.error ===
      "CommunityNotFound" &&
      !(
        (await av(Q.list, { topic: "Verification" })).body
          .communities as Array<any>
      ).some((c) => c.uri === dCommunity.uri),
    "the community D created is hidden too"
  )
  const asD = {
    thread: await call(APPVIEW, Q.thread, {
      params: { uri: aRef.uri },
      auth: dTokens.thread,
    }),
    profile: await call(APPVIEW, Q.profile, {
      params: { actor: A.handle },
      auth: dTokens.profile,
    }),
    community: await call(APPVIEW, Q.community, {
      params: { uri: guild },
      auth: dTokens.community,
    }),
  }
  check(
    asD.thread.ok &&
      asD.thread.body.thread.post.viewer === undefined &&
      asD.profile.ok &&
      asD.profile.body.viewer === undefined &&
      asD.community.ok &&
      asD.community.body.viewer === undefined,
    "asked as D itself, no view shows D's like, follow or membership",
    "no other view ever lists likes, follows or members"
  )
  const [kept9] = await db`
    select (select count(*)::int from post_like where uri = ${dLike.body.uri}) +
           (select count(*)::int from follow where uri = ${dFollow.body.uri}) +
           (select count(*)::int from membership where uri = ${dJoin.body.uri}) as n`
  check(
    kept9.n === 3,
    "the rows are hidden, not deleted: deactivation is reversible"
  )

  await call(PDS, "com.atproto.server.activateAccount", {
    post: true,
    auth: D.jwt,
  })
  const back = await until(
    async () =>
      feedUris(await av(Q.posts, { community: guild })).includes(dPost.uri) &&
      (await thread(aRef.uri, D)).body.thread?.post.viewer?.like ===
        dLike.body.uri
  )
  check(
    Boolean(back.value),
    "reactivating D brings everything back",
    took(back)
  )
} catch (err) {
  check(false, "unexpected error", (err as Error).stack ?? String(err))
} finally {
  section("cleanup")
  if (stoppedIndexer) await admin("indexer/start")
  for (const a of accounts) {
    await call(PDS, "com.atproto.admin.deleteAccount", {
      body: { did: a.did },
      auth: PDS_ADMIN,
    })
  }
  const purged = await until(async () => {
    if (accounts.length === 0) return true
    const [row] =
      await db`select count(*)::int as n from actor where did in ${db(accounts.map((a) => a.did))}`
    return row.n === 0
  })
  check(
    Boolean(purged.value),
    `${accounts.length} throwaway account(s) deleted, with their records`,
    took(purged)
  )
  await db.close()
}

console.log(
  failures === 0
    ? `\nall ${passes} checks passed`
    : `\n${failures} check(s) failed, ${passes} passed`
)
process.exit(failures === 0 ? 0 : 1)
