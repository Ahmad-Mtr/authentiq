/**
 * Seeds the job board (phase 7) with the synthetic postings in
 * infra/fixtures/jobs/postings.ts, written to the local PDS by the demo
 * accounts and a few talent-corpus recruiters, so they travel the real path:
 *
 *   PDS → firehose → indexer (lexicon, salary transparency) → Postgres
 *       → embedding worker → pgvector
 *
 * Seven postings break a salary-transparency rule on purpose (no salary,
 * min > max, a range over 2×, an unknown currency, a zero minimum, an
 * unknown period, no currency). They are written raw: the PDS stores them,
 * and the script then checks the AppView indexed none of them.
 *
 * It also restores the salary-less posting phase 0 wrote into alice.test's
 * repo by hand, at the same record key (`3mvvqk2qn5s2k`). `verify:jobs`
 * checks that it is still there and still not shown, so a clean start needs
 * it back.
 *
 * Idempotent: record keys are deterministic TIDs and createdAt is fixed, so
 * a second run writes nothing. A posting that changed since the last run is
 * replaced in place with putRecord (postings are editable). Needs `bun run
 * seed`, `bun run seed:talent` and `bun run dev`.
 *
 *   bun run seed:jobs
 */
import { join } from "node:path"
import { SQL } from "bun"
import { LOCAL_NETWORK } from "@workspace/atproto"
import { sh } from "@workspace/lexicons"
import { POSTINGS, createdAtOf, rkeyOf } from "../fixtures/jobs/postings.ts"

const root = join(import.meta.dir, "..", "..")
const infraEnv = Object.fromEntries(
  (await Bun.file(join(root, "infra/.env")).text())
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
)
const PDS = process.env.PDS_URL ?? LOCAL_NETWORK.pdsUrl
const PASSWORD = "password"
const WAIT_MS = 120_000
const POSTING = sh.authentiq.job.posting

async function xrpc(
  method: string,
  opts: { body?: unknown; params?: Record<string, string>; auth?: string }
) {
  const url = new URL(`/xrpc/${method}`, PDS)
  for (const [k, v] of Object.entries(opts.params ?? {}))
    url.searchParams.set(k, v)
  const res = await fetch(url, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: {
      ...(opts.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return {
    ok: res.ok,
    body: (await res.json().catch(() => ({}))) as Record<string, any>,
  }
}

type Session = { did: string; jwt: string }
const sessions = new Map<string, Session>()
async function session(handle: string): Promise<Session> {
  const cached = sessions.get(handle)
  if (cached) return cached
  const res = await xrpc("com.atproto.server.createSession", {
    body: { identifier: handle, password: PASSWORD },
  })
  if (!res.ok) {
    throw new Error(
      `${handle}: ${res.body.message ?? res.body.error} — run \`bun run seed\` and \`bun run seed:talent\` first`
    )
  }
  const s = { did: res.body.did as string, jwt: `Bearer ${res.body.accessJwt}` }
  sessions.set(handle, s)
  return s
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b))
        )
      : x
  )

let written = 0
let unchanged = 0
const valid: Array<{ key: string; uri: string }> = []
const invalid: Array<{ key: string; uri: string; why: string }> = []

for (const [i, p] of POSTINGS.entries()) {
  const createdAt = createdAtOf(i)
  const rkey = rkeyOf(i)
  const raw = { $type: POSTING.$type, ...p.record, createdAt }
  // Valid postings go through the lexicon, as the web form's do. Invalid
  // ones are written exactly as they are, the way any client could.
  const record = p.invalid
    ? (JSON.parse(JSON.stringify(raw)) as Record<string, unknown>)
    : POSTING.$parse(raw)
  const s = await session(p.by)
  const existing = await xrpc("com.atproto.repo.getRecord", {
    params: { repo: s.did, collection: POSTING.$nsid, rkey },
  })
  let uri = existing.body.uri as string | undefined
  if (existing.ok && canonical(existing.body.value) === canonical(record)) {
    unchanged++
  } else {
    const res = await xrpc("com.atproto.repo.putRecord", {
      body: { repo: s.did, collection: POSTING.$nsid, rkey, record },
      auth: s.jwt,
    })
    if (!res.ok) throw new Error(`${p.by} ${p.key}: ${res.body.message}`)
    uri = res.body.uri as string
    written++
  }
  if (p.invalid) invalid.push({ key: p.key, uri: uri!, why: p.invalid })
  else valid.push({ key: p.key, uri: uri! })
}
// alice's phase 0 record: no salary, no organization, written raw.
{
  const record = {
    $type: POSTING.$type,
    title: "No salary listed",
    createdAt: "2026-09-20T00:00:00Z",
  }
  const rkey = "3mvvqk2qn5s2k"
  const s = await session("alice.test")
  const existing = await xrpc("com.atproto.repo.getRecord", {
    params: { repo: s.did, collection: POSTING.$nsid, rkey },
  })
  if (existing.ok && canonical(existing.body.value) === canonical(record)) {
    unchanged++
  } else {
    const res = await xrpc("com.atproto.repo.putRecord", {
      body: { repo: s.did, collection: POSTING.$nsid, rkey, record },
      auth: s.jwt,
    })
    if (!res.ok) throw new Error(`alice.test phase 0 posting: ${res.body.message}`)
    written++
  }
  invalid.push({
    key: "alice-phase0",
    uri: `at://${s.did}/${POSTING.$nsid}/${rkey}`,
    why: "no salary (alice's phase 0 record)",
  })
}

console.log(
  `✓ ${POSTINGS.length + 1} postings (${valid.length} valid, ${invalid.length} invalid on purpose): ${written} written, ${unchanged} already up to date`
)

// --- wait for the index and the embeddings ----------------------------------------

const db = new SQL(
  `postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`
)

/**
 * The AppView has processed every commit in these repos once its `actor.rev`
 * reaches each repo's head. Events for one repo are handled in order, so by
 * then the invalid postings have been seen, and dropped.
 */
async function caughtUp() {
  for (const handle of new Set(POSTINGS.map((p) => p.by))) {
    const { did } = await session(handle)
    const head = await xrpc("com.atproto.sync.getLatestCommit", {
      params: { did },
    })
    const [row] = await db`select rev from actor where did = ${did}`
    if (!row?.rev || row.rev < head.body.rev) return false
  }
  return true
}

const started = performance.now()
let last = ""
for (;;) {
  const uris = valid.map((v) => v.uri)
  const [{ indexed, embedded }] = await db`
    select
      (select count(*)::int from job_posting where uri in ${db(uris)}) as indexed,
      (select count(*)::int from embedding
        where subject in ${db(uris)} and vector is not null and dirty_at is null) as embedded`
  const status = `${indexed}/${uris.length} indexed, ${embedded}/${uris.length} embedded`
  if (status !== last) console.log(`  ${status}`)
  last = status
  if (indexed === uris.length && embedded === uris.length && (await caughtUp()))
    break
  if (performance.now() - started > WAIT_MS) {
    console.log(
      `✗ timed out after ${WAIT_MS / 1000} s — is the AppView running (bun run dev)?`
    )
    await db.close()
    process.exit(1)
  }
  await Bun.sleep(250)
}

const leaked = await db`
  select uri from job_posting where uri in ${db(invalid.map((p) => p.uri))}`
await db.close()
if (leaked.length > 0) {
  console.log(`✗ ${leaked.length} invalid posting(s) were indexed`)
  process.exit(1)
}
console.log(
  `✓ job postings indexed and embedded (${Math.round(performance.now() - started)} ms)`
)
console.log(
  `✓ all ${invalid.length} invalid postings are in their authors' repos and not in the index: ${invalid.map((p) => p.why).join("; ")}`
)
