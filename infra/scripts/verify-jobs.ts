/**
 * End-to-end check of phase 7, job postings with enforced salary
 * transparency, against the live stack:
 *
 *   web BFF / PDS write → firehose → indexer (lexicon + salary rules)
 *     → Postgres → embedding worker → AppView queries and the agent
 *
 * Works on three throwaway accounts (`jp-…` poster, `js-…` seeker, `jo-…`
 * other), deleted at the end, plus the seeded postings (`bun run seed:jobs`)
 * and the talent corpus (`bun run seed:talent`). Writes that test the
 * AppView go straight to the PDS, the first of them with `curl`; writes that
 * test the web app go through its API routes over a real OAuth session.
 * Every wait is a poll with a timeout. Needs `bun run dev`.
 *
 *   bun run verify:jobs
 */
import { join } from "node:path"
import { $, SQL } from "bun"
import { LOCAL_NETWORK } from "@workspace/atproto"
import { POSTINGS, rkeyOf } from "../fixtures/jobs/postings.ts"
import { buildCorpus } from "../fixtures/talent/corpus.ts"
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
const PDS_ADMIN = `Basic ${btoa(`admin:${infraEnv.PDS_ADMIN_PASSWORD}`)}`
const TIMEOUT_MS = 10_000
const EMBED_TIMEOUT_MS = 30_000

const POSTING = "sh.authentiq.job.posting"
const Q = {
  list: "sh.authentiq.job.listPostings",
  get: "sh.authentiq.job.getPosting",
  similar: "sh.authentiq.job.getSimilarCandidates",
  match: "sh.authentiq.job.getMatch",
  profile: "sh.authentiq.actor.getProfile",
}
/** Alice's salary-less posting, written straight to the PDS in phase 0. */
const ALICE_PHASE0 = { handle: "alice.test", rkey: "3mvvqk2qn5s2k" }

const db = new SQL(
  `postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`
)
const corpus = new Map(buildCorpus().map((p) => [p.handle, p]))

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

type Res = { status: number; ok: boolean; body: Record<string, any> }

async function call(
  base: string,
  method: string,
  opts: {
    body?: unknown
    params?: Record<string, string | Array<string>>
    auth?: string
    /** A POST with no input (activateAccount takes none). */
    post?: boolean
  } = {}
): Promise<Res> {
  const url = new URL(`/xrpc/${method}`, base)
  for (const [k, v] of Object.entries(opts.params ?? {}))
    for (const x of [v].flat()) url.searchParams.append(k, x)
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
  const handle = `j${name}-${suffix}.test`
  const res = await call(PDS, "com.atproto.server.createAccount", {
    body: {
      handle,
      email: `j${name}-${suffix}@authentiq.test`,
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

const av = async (
  lxm: string,
  params: Record<string, string | Array<string>>,
  viewer?: Account
) =>
  call(APPVIEW, lxm, {
    params,
    auth: viewer ? await token(viewer, lxm) : undefined,
  })

const rkeyOfUri = (uri: string) => uri.split("/")[4]!
const createPosting = (a: Account, record: Record<string, unknown>) =>
  call(PDS, "com.atproto.repo.createRecord", {
    body: { repo: a.did, collection: POSTING, record },
    auth: a.jwt,
  })
const putPosting = (a: Account, uri: string, record: Record<string, unknown>) =>
  call(PDS, "com.atproto.repo.putRecord", {
    body: { repo: a.did, collection: POSTING, rkey: rkeyOfUri(uri), record },
    auth: a.jwt,
  })
const getRecord = (uri: string) =>
  call(PDS, "com.atproto.repo.getRecord", {
    params: {
      repo: uri.split("/")[2]!,
      collection: uri.split("/")[3]!,
      rkey: rkeyOfUri(uri),
    },
  })

/** A web API route, as the browser calls it, with the account's session. */
async function web(a: Account, path: string, body?: unknown) {
  const res = await a.web!.fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
  )
  return {
    status: res.status,
    ok: res.ok,
    body: (await res.json().catch(() => ({}))) as Record<string, any>,
  }
}
const page = async (path: string) => {
  const res = await fetch(`${WEB}${path}`)
  return { status: res.status, html: await res.text() }
}
const jobPath = (uri: string) =>
  `/jobs/${encodeURIComponent(uri.split("/")[2]!)}/${rkeyOfUri(uri)}`

const posting = (fields: Record<string, unknown>) => ({
  $type: POSTING,
  title: "Probe role",
  organization: "Probe Ltd",
  description: "A probe posting.",
  salary: { min: 50_000, max: 60_000, currency: "EUR", period: "year" },
  createdAt: new Date().toISOString(),
  ...fields,
})
/** The web form's JSON body for a posting. */
const form = (fields: Record<string, unknown>) => ({
  title: "Probe role",
  organization: "Probe Ltd",
  description: "A probe posting.",
  employmentType: "full-time",
  skills: "",
  salary: { min: "50000", max: "60000", currency: "EUR", period: "year" },
  ...fields,
})

const boardUris = async (params: Record<string, string | Array<string>>) => {
  const r = await av(Q.list, { limit: "100", ...params })
  return r.ok
    ? (r.body.postings as Array<any>).map((p) => p.uri as string)
    : undefined
}
const indexedRow = async (uri: string) =>
  (await db`select uri, cid, title from job_posting where uri = ${uri}`)[0]
const embeddingOf = async (uri: string) =>
  (
    await db`select document, content_hash, vector is not null as has_vector, dirty_at from embedding where subject = ${uri}`
  )[0]
const embedded = (uri: string) =>
  until(async () => {
    const e = await embeddingOf(uri)
    return e?.has_vector && !e.dirty_at ? e : undefined
  }, EMBED_TIMEOUT_MS)
const sameSet = (a: Array<string>, b: Array<string>) =>
  a.length === b.length && a.every((x) => b.includes(x))

// --- agent turns (as verify:agent reads them) ------------------------------------

type Turn = {
  status: number
  conversationId?: string
  toolCalls: Array<{ id: string; name: string; arguments: any }>
  toolResults: Array<{
    id: string
    name: string
    summary: string
    uris: Array<string>
  }>
  final?: {
    text: string
    citations: Array<{ uri: string; kind?: string }>
    dropped: Array<string>
  }
  error?: string
}
async function readTurn(res: Response): Promise<Turn> {
  const turn: Turn = { status: res.status, toolCalls: [], toolResults: [] }
  if (!res.ok || !res.body) {
    turn.error = JSON.stringify(await res.json().catch(() => ({})))
    return turn
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let end
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const event = block.match(/^event: (.*)$/m)?.[1]
      const data = block.match(/^data: (.*)$/m)?.[1]
      if (!event || !data) continue
      const parsed = JSON.parse(data)
      if (event === "turn") turn.conversationId = parsed.conversationId
      if (event === "tool_call") turn.toolCalls.push(parsed)
      if (event === "tool_result") turn.toolResults.push(parsed)
      if (event === "final") turn.final = parsed
      if (event === "error") turn.error = parsed.message
    }
  }
  return turn
}
const ask = async (a: Account, message: string, conversationId?: string) =>
  readTurn(
    await a.web!.fetch("/api/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, conversationId }),
    })
  )
const describeTurn = (t: Turn) =>
  `tools [${t.toolCalls.map((c) => c.name).join(", ")}], ${t.final?.citations.length ?? 0} cited`

// --- 0. preconditions --------------------------------------------------------------

for (const [name, url] of [
  ["AppView", `${APPVIEW}/xrpc/_health`],
  ["web app", WEB],
] as const) {
  const res = await fetch(url).catch(() => null)
  if (!res?.ok) {
    console.log(
      `✗ ${name} not reachable at ${url} (start it with \`bun run dev\`)`
    )
    process.exit(1)
  }
}
const [{ n: seeded }] = await db`select count(*)::int as n from job_posting`
if (seeded < POSTINGS.filter((p) => !p.invalid).length) {
  console.log("✗ the seeded postings are not indexed (run `bun run seed:jobs`)")
  process.exit(1)
}

try {
  const P = await createAccount("p")
  const S = await createAccount("s")
  const O = await createAccount("o")
  check(
    true,
    "three throwaway accounts created on the PDS",
    accounts.map((a) => a.handle).join(", ")
  )
  // The seeker is a data engineer (below): a person, not in the corpus.
  const fieldOf = (handle: string) =>
    handle === S.handle ? "dataeng" : corpus.get(handle)?.field

  // The seeker has a public profile: a data engineer.
  for (const [collection, rkey, record] of [
    [
      "sh.authentiq.actor.profile",
      "self",
      {
        $type: "sh.authentiq.actor.profile",
        displayName: "Seeker Probe",
        headline: "Data Engineer · pipelines and warehouses",
        about:
          "I build batch pipelines in Airflow and dbt models with tests, and I keep Snowflake costs down.",
        openToWork: true,
        skills: ["SQL", "dbt", "Airflow", "Snowflake", "Python"],
        createdAt: new Date().toISOString(),
      },
    ],
    [
      "sh.authentiq.actor.position",
      undefined,
      {
        $type: "sh.authentiq.actor.position",
        title: "Data Engineer",
        organization: "Probe Analytics",
        startDate: "2022-03",
        description:
          "Moved 200 dbt models to Snowflake and built the Airflow platform.",
        createdAt: new Date().toISOString(),
      },
    ],
  ] as const) {
    const res = await call(
      PDS,
      rkey ? "com.atproto.repo.putRecord" : "com.atproto.repo.createRecord",
      {
        body: { repo: S.did, collection, ...(rkey ? { rkey } : {}), record },
        auth: S.jwt,
      }
    )
    if (!res.ok) throw new Error(`seeker profile: ${res.body.message}`)
  }
  for (const a of [P, S]) {
    a.web = await signInToWeb({
      web: WEB,
      pds: PDS,
      handle: a.handle,
      password: "password",
    })
  }
  check(true, "poster and seeker signed in to the web app over OAuth")

  // --- 1. the demo -------------------------------------------------------------------
  section("1. the demo: a salary-less posting, straight to the PDS with curl")

  const demoTitle = `Senior Engineer, salary on request ${suffix}`
  const demoRecord = {
    $type: POSTING,
    title: demoTitle,
    organization: "Opaque Pay Ltd",
    description:
      "Competitive salary. We will tell you the number in the final round.",
    locationType: "remote",
    createdAt: new Date().toISOString(),
  }
  const demoBody = JSON.stringify({
    repo: P.did,
    collection: POSTING,
    record: demoRecord,
  })
  const curled =
    await $`curl -s -X POST ${PDS}/xrpc/com.atproto.repo.createRecord -H ${`authorization: ${P.jwt}`} -H ${"content-type: application/json"} -d ${demoBody}`.text()
  const demo = JSON.parse(curled) as {
    uri: string
    cid: string
    validationStatus?: string
  }
  check(
    demo.validationStatus === "unknown",
    "the PDS accepts it: validationStatus “unknown”",
    `${demo.uri}`
  )
  const stored = await getRecord(demo.uri)
  check(
    stored.ok &&
      stored.body.value?.title === demoTitle &&
      stored.body.value?.salary === undefined,
    "it is stored in the repo, with no salary (getRecord)"
  )
  // A valid posting written after it, in the same repo: once it is indexed,
  // the salary-less one has been seen (events for one repo run in order).
  const sentinel = await createPosting(
    P,
    posting({ title: `Sentinel ${suffix}` })
  )
  const sentinelIn = await until(() => indexedRow(sentinel.body.uri))
  check(
    Boolean(sentinelIn.value),
    "a later valid posting in the same repo is indexed",
    took(sentinelIn)
  )
  check(
    !(await indexedRow(demo.uri)),
    "the salary-less posting is not in the index"
  )
  const demoGet = await av(Q.get, { uri: demo.uri })
  check(
    demoGet.status === 400 && demoGet.body.error === "PostingNotFound",
    "getPosting → PostingNotFound",
    `${demoGet.status} ${demoGet.body.error}`
  )
  const demoList = await boardUris({ author: P.did })
  check(
    Boolean(
      demoList &&
      !demoList.includes(demo.uri) &&
      demoList.includes(sentinel.body.uri)
    ),
    "listPostings never lists it",
    `${demoList?.length} posting(s) by the poster, the sentinel only`
  )
  const demoSearch = await boardUris({ q: `"salary on request ${suffix}"` })
  check(
    demoSearch?.length === 0,
    "search (listPostings q) does not find it",
    `${demoSearch?.length} hit(s)`
  )
  // The indexer queues every commit for the embedding worker; for a record
  // it dropped, the worker finds no document and removes the queue row.
  let everVector = false
  const noEmbedding = await until(async () => {
    const e = await embeddingOf(demo.uri)
    everVector ||= Boolean(e?.has_vector || e?.document)
    return !e
  })
  check(
    Boolean(noEmbedding.value) && !everVector,
    "it is never embedded, so it cannot be matched or suggested",
    "no document or vector; the queue drops it"
  )
  const demoPage = await page(jobPath(demo.uri))
  check(
    demoPage.status === 404,
    "its web page is a 404",
    String(demoPage.status)
  )
  const demoBoard = await page(`/jobs?q=${encodeURIComponent(suffix)}`)
  check(
    demoBoard.status === 200 && !demoBoard.html.includes(demoTitle),
    "the web board does not show it"
  )

  const alice = await call(PDS, "com.atproto.identity.resolveHandle", {
    params: { handle: ALICE_PHASE0.handle },
  })
  const aliceUri = `at://${alice.body.did}/${POSTING}/${ALICE_PHASE0.rkey}`
  const aliceRec = await getRecord(aliceUri)
  check(
    aliceRec.ok && aliceRec.body.value?.salary === undefined,
    "alice.test's phase 0 posting is still in her repo, salary-less",
    `“${aliceRec.body.value?.title}”`
  )
  const aliceGet = await av(Q.get, { uri: aliceUri })
  check(
    !(await indexedRow(aliceUri)) && aliceGet.body.error === "PostingNotFound",
    "…and absent from the index and getPosting"
  )
  const aliceBoard = await boardUris({ author: ALICE_PHASE0.handle })
  check(
    Boolean(aliceBoard && !aliceBoard.includes(aliceUri)),
    "…and from listPostings",
    `alice's board: ${aliceBoard?.length} valid posting(s)`
  )
  check(
    (await page(jobPath(aliceUri))).status === 404,
    "…and its web page is a 404"
  )

  // --- 2. the invalid seed postings ------------------------------------------------------
  section("2. every invalid seed posting: stored by the PDS, never indexed")

  for (const [i, p] of POSTINGS.entries()) {
    if (!p.invalid) continue
    const did = (
      await call(PDS, "com.atproto.identity.resolveHandle", {
        params: { handle: p.by },
      })
    ).body.did
    const uri = `at://${did}/${POSTING}/${rkeyOf(i)}`
    const rec = await getRecord(uri)
    const get = await av(Q.get, { uri })
    check(
      rec.ok &&
        !(await indexedRow(uri)) &&
        get.body.error === "PostingNotFound",
      `${p.invalid}: in ${p.by}'s repo, not in the index`,
      `“${p.record.title}”`
    )
  }

  // --- 3. a valid posting's lifecycle, through the web app -------------------------------
  section("3. post, edit, edit the salary away, delete (web app and PDS)")

  const created = await web(
    P,
    "/api/jobs",
    form({
      title: `Platform Engineer ${suffix}`,
      skills: "Kubernetes, Go",
      salary: { min: "90000", max: "120000", currency: "EUR", period: "year" },
    })
  )
  const J = created.body.uri as string
  check(
    created.ok && created.body.indexed === true,
    "POST /api/jobs as the poster writes it and waits for the index",
    `${created.status} ${J}`
  )
  const onBoard = await boardUris({ author: P.did })
  check(Boolean(onBoard?.includes(J)), "it appears in listPostings")
  const shown = await page(`/jobs?q=${encodeURIComponent(suffix)}`)
  check(
    shown.html.includes(`Platform Engineer ${suffix}`) &&
      shown.html.includes("EUR 90,000–120,000 a year"),
    "and on the web board, with its salary"
  )

  const edited = await web(P, "/api/jobs/update", {
    uri: J,
    ...form({
      title: `Staff Platform Engineer ${suffix}`,
      skills: "Kubernetes, Go",
      salary: { min: "110000", max: "140000", currency: "EUR", period: "year" },
    }),
  })
  const afterEdit = await av(Q.get, { uri: J })
  check(
    edited.ok &&
      edited.body.uri === J &&
      afterEdit.body.title === `Staff Platform Engineer ${suffix}` &&
      afterEdit.body.salary?.min === 110_000,
    "an edit (putRecord, same key) updates the board",
    `cid ${created.body.cid.slice(-6)} → ${edited.body.cid?.slice(-6)}`
  )

  const noSalary = await web(P, "/api/jobs/update", {
    uri: J,
    ...form({ salary: { min: "", max: "", currency: "EUR", period: "year" } }),
  })
  check(
    noSalary.status === 400 &&
      noSalary.body.issues?.some((i: any) => i.path === "salary.min"),
    "the web form refuses an edit that removes the salary",
    `${noSalary.status} ${noSalary.body.message}`
  )
  const inverted = await web(P, "/api/jobs/update", {
    uri: J,
    ...form({
      salary: { min: "90000", max: "60000", currency: "EUR", period: "year" },
    }),
  })
  check(
    inverted.status === 400 && /above the maximum/.test(inverted.body.message),
    "…and one with min > max",
    inverted.body.message
  )
  const tooWide = await web(
    P,
    "/api/jobs",
    form({
      salary: { min: "1", max: "10000000", currency: "USD", period: "year" },
    })
  )
  check(
    tooWide.status === 400 && /too wide/.test(tooWide.body.message),
    "…and a new posting reading $1–$10,000,000",
    tooWide.body.message
  )
  const badCurrency = await web(
    P,
    "/api/jobs",
    form({ salary: { min: "10", max: "12", currency: "BTC", period: "hour" } })
  )
  check(
    badCurrency.status === 400 &&
      badCurrency.body.issues?.some((i: any) => i.path === "salary.currency"),
    "…and an unknown currency",
    badCurrency.body.message
  )
  check(
    !(await boardUris({ author: P.did }))?.some(
      (u) => u !== J && u !== sentinel.body.uri
    ),
    "none of the refused writes reached the repo or the board"
  )

  const {
    $type: _t,
    salary: _s,
    ...withoutSalary
  } = (await getRecord(J)).body.value as Record<string, unknown>
  const stripped = await putPosting(P, J, { $type: POSTING, ...withoutSalary })
  check(
    stripped.ok && stripped.body.validationStatus === "unknown",
    "the same edit straight to the PDS is accepted",
    stripped.body.validationStatus
  )
  const offBoard = await until(
    async () => (await av(Q.get, { uri: J })).body.error === "PostingNotFound"
  )
  check(
    Boolean(offBoard.value),
    "…and takes the posting off the board",
    took(offBoard)
  )
  check(
    !(await boardUris({ author: P.did }))?.includes(J) &&
      !(await indexedRow(J)),
    "…out of listPostings and the index"
  )
  const embGone = await until(async () => !(await embeddingOf(J)))
  check(Boolean(embGone.value), "…and its embedding is removed", took(embGone))
  const restored = await web(P, "/api/jobs/update", {
    uri: J,
    ...form({
      title: `Staff Platform Engineer ${suffix}`,
      salary: { min: "110000", max: "140000", currency: "EUR", period: "year" },
    }),
  })
  check(
    restored.ok && restored.body.indexed === true,
    "fixing it through the web form puts it back",
    restored.status === 200 ? "on the board again" : String(restored.status)
  )
  const deleted = await web(P, "/api/jobs/delete", { uri: J })
  check(
    deleted.ok && deleted.body.indexed === true,
    "POST /api/jobs/delete removes it",
    String(deleted.status)
  )
  const afterDelete = await av(Q.get, { uri: J })
  check(
    afterDelete.body.error === "PostingNotFound" &&
      !(await getRecord(J)).ok &&
      !(await boardUris({ author: P.did }))?.includes(J),
    "gone from getPosting, listPostings and the repo"
  )
  const otherDelete = await web(S, "/api/jobs/delete", {
    uri: sentinel.body.uri,
  })
  check(
    otherDelete.status === 403,
    "nobody else can delete it through the web app",
    String(otherDelete.status)
  )

  // --- 4. filters and sorting ----------------------------------------------------------
  section(
    "4. salary floor across periods and currencies; remote, location, skills; sorting"
  )

  const t0 = Date.now() - 60 * 60 * 1000
  const F: Record<string, string> = {}
  for (const [i, [key, fields]] of (
    [
      [
        "F1",
        {
          title: `F1 hourly ${suffix}`,
          salary: { min: 50, max: 60, currency: "USD", period: "hour" },
          locationType: "remote",
          location: "Lisbon, Portugal",
          skills: ["Go", "Kafka"],
          employmentType: "full-time",
        },
      ],
      [
        "F2",
        {
          title: `F2 yearly ${suffix}`,
          salary: {
            min: 100_000,
            max: 120_000,
            currency: "USD",
            period: "year",
          },
          locationType: "onsite",
          location: "Austin, TX",
          skills: ["Go"],
          employmentType: "full-time",
        },
      ],
      [
        "F3",
        {
          title: `F3 monthly ${suffix}`,
          salary: { min: 8_000, max: 9_000, currency: "USD", period: "month" },
          locationType: "hybrid",
          location: "Lisbon, Portugal",
          skills: ["Kafka"],
          employmentType: "contract",
        },
      ],
      [
        "F4",
        {
          title: `F4 euros ${suffix}`,
          salary: {
            min: 110_000,
            max: 130_000,
            currency: "EUR",
            period: "year",
          },
          locationType: "remote",
          location: "Berlin, Germany",
          skills: ["Go", "Kafka"],
          employmentType: "full-time",
        },
      ],
      [
        "F5",
        {
          title: `F5 daily ${suffix}`,
          salary: { min: 400, max: 500, currency: "USD", period: "day" },
          locationType: "remote",
          location: "Austin, TX",
          skills: ["Terraform"],
          employmentType: "contract",
        },
      ],
    ] as const
  ).entries()) {
    const r = await createPosting(
      P,
      posting({ ...fields, createdAt: new Date(t0 + i * 60_000).toISOString() })
    )
    F[key] = r.body.uri
  }
  const fIn = await until(async () => {
    const rows =
      await db`select count(*)::int as n from job_posting where uri in ${db(Object.values(F))}`
    return rows[0].n === 5
  })
  check(
    Boolean(fIn.value),
    "five postings indexed: USD per hour, year, month and day, and one in EUR",
    took(fIn)
  )
  const name = (uris: Array<string> | undefined) =>
    (uris ?? [])
      .map((u) => Object.entries(F).find(([, v]) => v === u)?.[0] ?? "?")
      .join(",")
  const mine = { author: P.did }
  const expectSet = async (
    label: string,
    params: Record<string, string | Array<string>>,
    want: Array<string>
  ) => {
    const got = await boardUris({ ...mine, ...params })
    check(
      Boolean(
        got &&
        sameSet(
          got.filter((u) => Object.values(F).includes(u)),
          want.map((k) => F[k]!)
        )
      ),
      label,
      `[${name(got?.filter((u) => Object.values(F).includes(u)))}]`
    )
  }
  await expectSet(
    "USD ≥ 100,000 a year → F1 (50/h = 104,000), F2 (100,000), F5 (400/day = 104,000)",
    { currency: "USD", minSalary: "100000", salaryPeriod: "year" },
    ["F1", "F2", "F5"]
  )
  await expectSet(
    "USD ≥ 50 an hour (= 104,000 a year) → F1, F5; not F2",
    { currency: "USD", minSalary: "50", salaryPeriod: "hour" },
    ["F1", "F5"]
  )
  await expectSet(
    "USD ≥ 8,000 a month (= 96,000 a year) → F1, F2, F3, F5",
    { currency: "USD", minSalary: "8000", salaryPeriod: "month" },
    ["F1", "F2", "F3", "F5"]
  )
  await expectSet(
    "USD ≥ 2,000 a week (= 104,000) → F1, F5",
    { currency: "USD", minSalary: "2000", salaryPeriod: "week" },
    ["F1", "F5"]
  )
  await expectSet(
    "EUR ≥ 100,000 a year → F4 only: USD postings are never compared",
    { currency: "EUR", minSalary: "100000" },
    ["F4"]
  )
  const noCurrency = await av(Q.list, { minSalary: "100000" })
  check(
    noCurrency.status === 400,
    "a floor without a currency is refused",
    noCurrency.body.message
  )
  await expectSet("remote → F1, F4, F5", { locationType: "remote" }, [
    "F1",
    "F4",
    "F5",
  ])
  await expectSet(
    "remote or hybrid → F1, F3, F4, F5",
    { locationType: ["remote", "hybrid"] },
    ["F1", "F3", "F4", "F5"]
  )
  await expectSet("location “lisbon” → F1, F3", { location: "lisbon" }, [
    "F1",
    "F3",
  ])
  await expectSet("skills Go and Kafka → F1, F4", { skills: ["Go", "Kafka"] }, [
    "F1",
    "F4",
  ])
  await expectSet("skills “go” (any case) → F1, F2, F4", { skills: ["go"] }, [
    "F1",
    "F2",
    "F4",
  ])
  await expectSet("contract → F3, F5", { employmentType: "contract" }, [
    "F3",
    "F5",
  ])
  await expectSet(
    "remote, USD ≥ 100,000 a year → F1, F5",
    { locationType: "remote", currency: "USD", minSalary: "100000" },
    ["F1", "F5"]
  )
  const newest = (await boardUris({ ...mine, q: suffix }))?.filter((u) =>
    Object.values(F).includes(u)
  )
  check(
    name(newest) === "F5,F4,F3,F2,F1",
    "sort newest (default)",
    name(newest)
  )
  const bySalary = await boardUris({ ...mine, currency: "USD", sort: "salary" })
  check(
    name(bySalary) === "F5,F1,F2,F3",
    "sort by salary (USD): highest yearly minimum, then maximum",
    `${name(bySalary)} (104k/130k, 104k/124.8k, 100k, 96k)`
  )
  const salaryNoCurrency = await av(Q.list, { sort: "salary" })
  check(
    salaryNoCurrency.status === 400,
    "sort by salary without a currency is refused",
    salaryNoCurrency.body.message
  )
  for (const [label, params, want] of [
    ["newest", { ...mine, q: suffix }, "F5,F4,F3,F2,F1"],
    ["salary", { ...mine, currency: "USD", sort: "salary" }, "F5,F1,F2,F3"],
  ] as const) {
    const pages: Array<string> = []
    let cursor: string | undefined
    let n = 0
    do {
      const r = await av(Q.list, {
        ...params,
        limit: "2",
        ...(cursor ? { cursor } : {}),
      })
      pages.push(
        name(
          (r.body.postings as Array<any>)
            .map((p) => p.uri)
            .filter((u: string) => Object.values(F).includes(u))
        )
      )
      cursor = r.body.cursor
    } while (cursor && ++n < 10)
    check(
      pages.join(",").replace(/^,|,$/g, "") === want,
      `cursor pagination, sort ${label}, 2 per page`,
      pages.map((p) => `[${p}]`).join(" ")
    )
  }
  const webFloor = await page(
    `/jobs?currency=USD&minSalary=50&salaryPeriod=hour&q=${suffix}`
  )
  check(
    webFloor.html.includes(`F1 hourly ${suffix}`) &&
      webFloor.html.includes(`F5 daily ${suffix}`) &&
      !webFloor.html.includes(`F2 yearly ${suffix}`) &&
      !webFloor.html.includes(`F4 euros ${suffix}`),
    "the web board applies the same floor",
    "USD 50 an hour: F1 and F5 shown"
  )
  check(
    webFloor.html.includes("never converted between currencies"),
    "and says currencies are not converted"
  )

  // --- 5. close dates and deactivation ---------------------------------------------------
  section("5. close dates; a deactivated poster's postings")

  const dayUTC = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const past = await createPosting(
    P,
    posting({ title: `Closed ${suffix}`, closeDate: dayUTC(-2) })
  )
  const today = await createPosting(
    P,
    posting({ title: `Closes today ${suffix}`, closeDate: dayUTC(0) })
  )
  const closeIn = await until(
    async () =>
      (await indexedRow(past.body.uri)) && (await indexedRow(today.body.uri))
  )
  check(
    Boolean(closeIn.value),
    "a posting closed two days ago and one closing today are both indexed",
    took(closeIn)
  )
  const closedBoard = await boardUris(mine)
  check(
    !closedBoard?.includes(past.body.uri),
    "the closed one is not on the board",
    dayUTC(-2)
  )
  check(
    Boolean(closedBoard?.includes(today.body.uri)),
    "the one whose date is today is (open until the day ends everywhere)",
    dayUTC(0)
  )
  const closedGet = await av(Q.get, { uri: past.body.uri })
  check(
    closedGet.ok && closedGet.body.closed === true,
    "getPosting still answers for it, with closed: true"
  )
  check(
    (await page(jobPath(past.body.uri))).html.includes(
      "This posting has closed"
    ),
    "its web page says it has closed"
  )
  await putPosting(
    P,
    today.body.uri,
    posting({ title: `Closes today ${suffix}`, closeDate: dayUTC(-2) })
  )
  const leaves = await until(
    async () => !(await boardUris(mine))?.includes(today.body.uri)
  )
  check(
    Boolean(leaves.value),
    "moving a close date into the past takes it off the board",
    took(leaves)
  )

  const oPosting = await createPosting(
    O,
    posting({ title: `Other's role ${suffix}` })
  )
  const oIn = await until(async () =>
    (await boardUris({ author: O.did }))?.includes(oPosting.body.uri)
  )
  check(
    Boolean(oIn.value),
    "another account's posting is on the board",
    took(oIn)
  )
  await embedded(oPosting.body.uri)
  const deact = await call(PDS, "com.atproto.server.deactivateAccount", {
    body: {},
    auth: O.jwt,
  })
  const hidden = await until(
    async () =>
      (await av(Q.get, { uri: oPosting.body.uri })).body.error ===
      "PostingNotFound"
  )
  check(
    deact.ok && Boolean(hidden.value),
    "deactivating the poster hides it: getPosting → PostingNotFound",
    took(hidden)
  )
  check(
    !(await boardUris({}))?.includes(oPosting.body.uri),
    "it is not on the board"
  )
  check(
    (await page(jobPath(oPosting.body.uri))).status === 404,
    "its web page is a 404"
  )
  check(
    Boolean(await indexedRow(oPosting.body.uri)) &&
      !(await embeddingOf(oPosting.body.uri)),
    "the row is kept (reversible), the embedding removed"
  )
  const react = await call(PDS, "com.atproto.server.activateAccount", {
    post: true,
    auth: O.jwt,
  })
  if (!react.ok)
    console.log(`  activateAccount: ${react.status} ${react.body.message}`)
  const back = await until(
    async () => (await av(Q.get, { uri: oPosting.body.uri })).ok
  )
  check(Boolean(back.value), "reactivating brings it back", took(back))
  const reEmbedded = await embedded(oPosting.body.uri)
  check(
    Boolean(reEmbedded.value),
    "and it is embedded again",
    took(reEmbedded, EMBED_TIMEOUT_MS)
  )

  // --- 6. embeddings and similar candidates ----------------------------------------------
  section(
    "6. embeddings; similar candidates for the author only; protected wording has no effect"
  )

  const base = {
    title: `Data Engineer ${suffix}`,
    organization: "Probe Analytics",
    skills: "SQL, dbt, Airflow, Snowflake",
    salary: { min: "85000", max: "105000", currency: "EUR", period: "year" },
    locationType: "hybrid",
  }
  const cleanText =
    "Build and run our batch pipelines in Airflow, keep every dbt model tested, and control Snowflake spend."
  const clean = await web(
    P,
    "/api/jobs",
    form({ ...base, description: cleanText })
  )
  const worded = await web(
    P,
    "/api/jobs",
    form({
      ...base,
      description: `${cleanText}\nYoung, energetic, native English speaker.`,
    })
  )
  const inline = await web(
    P,
    "/api/jobs",
    form({
      ...base,
      description:
        "We are a young, energetic team looking for a native English speaker to build and run our batch pipelines in Airflow, keep every dbt model tested, and control Snowflake spend.",
    })
  )
  const [C, W, I] = [
    clean.body.uri as string,
    worded.body.uri as string,
    inline.body.uri as string,
  ]
  const embC = await embedded(C)
  const embW = await embedded(W)
  const embI = await embedded(I)
  check(
    Boolean(embC.value && embW.value && embI.value),
    "postings are embedded after the firehose delivers them",
    took(embC, EMBED_TIMEOUT_MS)
  )
  const docC = embC.value!.document as string
  check(
    docC.startsWith(`Role: Data Engineer ${suffix}`) &&
      !docC.includes("Probe Analytics") &&
      !docC.includes("85000"),
    "the document is the work: role, type, skills, description; no organization or salary",
    JSON.stringify(docC.split("\n")[0])
  )

  const similar = async (
    uri: string,
    as?: Account,
    extra: Record<string, string> = {}
  ) => av(Q.similar, { posting: uri, limit: "5", ...extra }, as)
  const simC = await similar(C, P)
  const handles = (r: Res) =>
    ((r.body.candidates ?? []) as Array<any>).map((c) => c.handle as string)
  const hC = handles(simC)
  const inField = hC.filter((h) => fieldOf(h) === "dataeng").length
  check(
    simC.ok && inField >= 3,
    "similar candidates are data engineers (talent corpus, plus the seeker)",
    `${inField}/5 in the field: ${hC.map((h) => `${h.replace(".test", "")}:${fieldOf(h) ?? "?"}`).join(" ")}`
  )
  const allOpen = await Promise.all(
    hC.map(
      async (h) => (await av(Q.profile, { actor: h })).body.openToWork === true
    )
  )
  check(
    allOpen.every(Boolean) && !hC.includes(P.handle),
    "all are open to work, and the author is left out",
    `${allOpen.filter(Boolean).length}/${hC.length} open to work`
  )
  const simS = await similar(C, S)
  check(
    simS.status === 403 && simS.body.error === "NotPostingAuthor",
    "another account is refused: NotPostingAuthor",
    `${simS.status}`
  )
  const simAnon = await call(APPVIEW, Q.similar, { params: { posting: C } })
  check(
    simAnon.status === 401,
    "an unauthenticated call is refused",
    `${simAnon.status} ${simAnon.body.error}`
  )
  const simWrongLxm = await call(APPVIEW, Q.similar, {
    params: { posting: C },
    auth: await token(P, Q.match),
  })
  check(
    simWrongLxm.status === 401,
    "the author's token for another method is refused",
    `${simWrongLxm.status} ${simWrongLxm.body.error}`
  )
  const simWebS = await web(
    S,
    `/api/jobs/similar?posting=${encodeURIComponent(C)}`
  )
  const simWebAnon = await fetch(
    `${WEB}/api/jobs/similar?posting=${encodeURIComponent(C)}`
  )
  check(
    simWebS.status === 403 && simWebAnon.status === 401,
    "the web route refuses the seeker (403) and anonymous callers (401)"
  )
  const simWebP = await web(
    P,
    `/api/jobs/similar?posting=${encodeURIComponent(C)}`
  )
  check(
    simWebP.ok &&
      sameSet(
        simWebP.body.candidates.map((c: any) => c.handle).slice(0, 5),
        hC
      ),
    "the author gets the same list through the web app"
  )
  const keys = JSON.stringify(simC.body)
  check(
    !/score|similarity|label|rank/i.test(keys),
    "no score of any kind is given for any candidate"
  )

  const embWDoc = embW.value!.document as string
  check(
    embWDoc === docC && embW.value!.content_hash === embC.value!.content_hash,
    "a description ending “Young, energetic, native English speaker.” gives the identical document and hash",
    "same vector"
  )
  const simW = await similar(W, P)
  check(
    JSON.stringify(handles(simW)) === JSON.stringify(hC),
    "and identical similar candidates, in the same order"
  )
  const docI = embI.value!.document as string
  check(
    !/young|energetic|native/i.test(docI),
    "inline wording (“a young, energetic team … a native English speaker”) is stripped from the document",
    JSON.stringify(docI.split("\n").at(-1)!.slice(0, 70) + "…")
  )
  const hI = handles(await similar(I, P))
  note(
    "inline-worded posting's candidates vs the clean one's",
    `${hI.filter((h) => hC.includes(h)).length}/5 shared; the residue (“We are a team looking for a to build…”) is not identical text, so this is reported, not asserted`
  )
  const asAuthor = await av(Q.get, { uri: W }, P)
  const flagged = asAuthor.body.viewer?.ignoredTerms as
    Array<string> | undefined
  check(
    Boolean(
      flagged &&
      ["young", "energetic", "native english speaker"].every((t) =>
        flagged.includes(t)
      )
    ),
    "the author is told what is ignored",
    JSON.stringify(flagged)
  )
  const asOther = await av(Q.get, { uri: W }, S)
  const anon = await av(Q.get, { uri: W })
  check(
    asOther.body.viewer?.isAuthor === false &&
      asOther.body.viewer?.ignoredTerms === undefined &&
      anon.body.viewer === undefined,
    "nobody else is (not the seeker, not anonymous callers)"
  )

  // --- 7. match score ----------------------------------------------------------------------
  section("7. match score: only ever the caller's own")

  const seekerEmbedded = await embedded(S.did)
  check(
    Boolean(seekerEmbedded.value),
    "the seeker's profile is embedded",
    took(seekerEmbedded, EMBED_TIMEOUT_MS)
  )
  const matchC = await av(Q.match, { posting: C }, S)
  check(
    matchC.ok && ["strong", "partial"].includes(matchC.body.label),
    "a data engineer vs the data engineering posting",
    `${matchC.body.label}; skills in common: ${matchC.body.matchedSkills?.join(", ")}`
  )
  const nurse = POSTINGS.findIndex((p) => p.key === "nurse-stmargaret")
  const nurseDid = (
    await call(PDS, "com.atproto.identity.resolveHandle", {
      params: { handle: POSTINGS[nurse]!.by },
    })
  ).body.did
  const matchNurse = await av(
    Q.match,
    { posting: `at://${nurseDid}/${POSTING}/${rkeyOf(nurse)}` },
    S
  )
  check(
    matchNurse.body.label === "weak",
    "the same person vs a critical care nursing posting",
    `${matchNurse.body.label}; skills in common: ${matchNurse.body.matchedSkills?.length ?? 0}`
  )
  check(
    Object.keys(matchC.body).every((k) =>
      ["posting", "label", "matchedSkills", "pending"].includes(k)
    ),
    "the response is a coarse label, no number",
    Object.keys(matchC.body).join(", ")
  )
  const matchAnon = await call(APPVIEW, Q.match, { params: { posting: C } })
  check(
    matchAnon.status === 401,
    "unauthenticated → refused",
    `${matchAnon.status} ${matchAnon.body.error}`
  )
  const matchWrong = await call(APPVIEW, Q.match, {
    params: { posting: C },
    auth: await token(S, Q.similar),
  })
  check(
    matchWrong.status === 401,
    "a token for another method → refused",
    `${matchWrong.status} ${matchWrong.body.error}`
  )
  for (const param of ["actor", "did"]) {
    const other = await call(APPVIEW, Q.match, {
      params: { posting: C, [param]: S.did },
      auth: await token(P, Q.match),
    })
    check(
      other.status === 400 && !("label" in other.body),
      `the author asking for the seeker's score (?${param}=…) → refused`,
      `${other.status} ${other.body.message}`
    )
  }
  const matchNoProfile = await av(Q.match, { posting: C }, O)
  check(
    matchNoProfile.body.error === "ProfileNotFound",
    "someone with no profile gets no score, only a prompt to add one",
    matchNoProfile.body.error
  )
  const webMatch = await web(
    S,
    `/api/jobs/match?posting=${encodeURIComponent(C)}`
  )
  check(
    webMatch.ok && webMatch.body.label === matchC.body.label,
    "the web route gives the seeker their own label",
    `${webMatch.body.state} ${webMatch.body.label}`
  )
  const webMatchAnon = await fetch(
    `${WEB}/api/jobs/match?posting=${encodeURIComponent(C)}`
  )
  check(
    webMatchAnon.status === 401,
    "the web route refuses anonymous callers",
    String(webMatchAnon.status)
  )
  const authorView = JSON.stringify([
    await av(Q.get, { uri: C }, P),
    simC.body,
    await av(Q.list, { author: P.did }, P),
  ])
  check(
    !authorView.includes('"label"') && !authorView.includes("matchedSkills"),
    "nothing the author can fetch carries anyone's match"
  )

  // --- 8. the agent ------------------------------------------------------------------------
  section(
    "8. the recruiting agent: get_job, search_talent with a job, citations"
  )

  const t1 = await ask(
    P,
    `Look up the job posting ${C} with get_job. Tell me its salary range and required skills, and link the posting.`
  )
  const t1Uris = new Set(t1.toolResults.flatMap((r) => r.uris))
  check(
    t1.toolCalls.some((c) => c.name === "get_job" && c.arguments?.uri === C),
    "get_job is called with the posting's uri",
    describeTurn(t1)
  )
  check(
    Boolean(t1.final?.citations.some((c) => c.uri === C && c.kind === "job")),
    "the answer cites the posting",
    t1.final?.citations
      .map((c) => c.uri.split("/").slice(3).join("/"))
      .join(", ")
  )
  check(
    Boolean(t1.final) &&
      t1.final!.citations.every((c) => t1Uris.has(c.uri)) &&
      t1.final!.dropped.length === 0,
    "every cited uri came from a tool result",
    `${t1.final?.citations.length} cited, ${t1.final?.dropped.length} dropped`
  )
  check(
    /85[,. ]?000|85k/i.test(t1.final?.text ?? "") &&
      /Airflow/i.test(t1.final?.text ?? ""),
    "the salary and skills in the answer are the posting's",
    (t1.final?.text ?? "").replace(/\s+/g, " ").slice(0, 110) + "…"
  )

  const t2 = await ask(
    P,
    "Now find three candidates for that posting: call search_talent with its uri as job. Link each candidate.",
    t1.conversationId
  )
  const t2Uris = new Set([...t1Uris, ...t2.toolResults.flatMap((r) => r.uris)])
  const searched = t2.toolCalls.find((c) => c.name === "search_talent")
  check(
    searched?.arguments?.job === C,
    "search_talent is called with the job's uri",
    JSON.stringify(searched?.arguments ?? null)
  )
  const cited = t2.final?.citations ?? []
  check(
    cited.length > 0 &&
      cited.every((c) => t2Uris.has(c.uri)) &&
      (t2.final?.dropped.length ?? 1) === 0,
    "every candidate and job it cites came from a tool result",
    `${cited.length} cited (${cited.filter((c) => c.kind === "job").length} job), ${t2.final?.dropped.length} dropped`
  )
  const citedPeople = cited
    .filter((c) => c.kind !== "job")
    .map((c) => c.uri.split("/")[2])
  const peopleFields = await Promise.all(
    citedPeople.map(async (did) =>
      fieldOf((await av(Q.profile, { actor: did! })).body.handle)
    )
  )
  check(
    peopleFields.filter((f) => f === "dataeng").length >=
      Math.min(2, peopleFields.length),
    "the candidates are data engineers",
    peopleFields.join(", ")
  )

  const t3 = await ask(
    S,
    `Find candidates for the job posting ${C} using search_talent with that uri as job.`
  )
  const s3 = t3.toolCalls.find(
    (c) => c.name === "search_talent" && c.arguments?.job
  )
  const s3Result = t3.toolResults.find((r) => r.id === s3?.id)
  if (s3) {
    check(
      s3Result?.summary === "not the recruiter's posting" &&
        s3Result.uris.length === 0,
      "someone else's posting: search_talent refuses the job",
      s3Result?.summary
    )
  } else {
    note(
      "the seeker's agent did not pass the job to search_talent",
      describeTurn(t3)
    )
  }
} catch (err) {
  failures++
  console.log(`✗ ${(err as Error).message}`)
} finally {
  section("cleanup")
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
  check(
    removed === accounts.length && Boolean(gone.value),
    `${removed} throwaway account(s) deleted, with their postings`,
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
