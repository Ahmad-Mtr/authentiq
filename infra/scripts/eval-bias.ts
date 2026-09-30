/**
 * Counterfactual bias check for talent search, match bands and similar
 * candidates (phase 9). The question: does anything move when only a
 * protected-attribute signal changes?
 *
 * For one person per field (from the talent corpus, the one with the most
 * relevance labels), it creates pairs of throwaway accounts that copy that
 * person's profile, positions and education exactly, and differ only in a
 * few words of their headline or about text:
 *
 *   gender            (she/her) · mother · maternity · chairwoman   vs  (he/him) · father · paternity · chairman
 *   gender, reworded  "working mum"                                  vs  "working dad"
 *   religion          church                                         vs  mosque
 *   culture, reworded Christmas · Lent                               vs  Eid · Ramadan
 *   age               58-year-old · born 1967                        vs  26-year-old · born 1999
 *   age, reworded     Walkman generation · dial-up                   vs  TikTok generation · smartphones
 *   name in the text  "Friends call me Emily"                        vs  "Friends call me Aisha"
 *
 * The "reworded" pairs use words the protected-term list is not expected
 * to know, to measure what the list misses. Each pair is compared on:
 *
 *   document   is the stored profile document (what is embedded and
 *              full-text indexed) identical after redaction?
 *   vector     cosine similarity of the two embeddings
 *   search     for every labelled query the base person is relevant to,
 *              A's and B's rank in hybrid search among the real pool (every
 *              variant and the base person left out, so copies of one
 *              person do not count as competitors), and how many real
 *              people rank between them (0 = the change moved nobody past
 *              anybody), and the fused score gap
 *   match      the match band each of them gets for their field's posting
 *   similar    their positions in that posting's similar candidates
 *
 * It reports what it finds; nothing here is tuned to the result. All
 * accounts are deleted at the end. Needs the corpus, the job seeds, the
 * AppView and the embedding API.
 *
 *   bun run eval:bias
 *   bun run eval:bias -- --fields sre,nursing
 */
import { join } from "node:path"
import { SQL } from "bun"
import { LOCAL_NETWORK } from "@workspace/atproto"
import { sh } from "@workspace/lexicons"
import { POSTINGS, rkeyOf } from "../fixtures/jobs/postings.ts"
import { buildCorpus } from "../fixtures/talent/corpus.ts"
import type { Person } from "../fixtures/talent/corpus.ts"

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
const PDS_ADMIN = `Basic ${btoa(`admin:${infraEnv.PDS_ADMIN_PASSWORD}`)}`
const EMBED_TIMEOUT_MS = 180_000

type Variant = { headline?: string; about: string }
type Dimension = {
  key: string
  reworded: boolean
  a: (p: Person) => Variant
  b: (p: Person) => Variant
}
const withAbout = (p: Person, extra: string): Variant => ({ about: `${p.profile.about} ${extra}` })
export const DIMENSIONS: Array<Dimension> = [
  {
    key: "gender",
    reworded: false,
    a: (p) => ({ headline: `${p.profile.headline} (she/her)`, about: `${p.profile.about} Mother of two, back from maternity leave since last spring. Chairwoman of the regional professional society.` }),
    b: (p) => ({ headline: `${p.profile.headline} (he/him)`, about: `${p.profile.about} Father of two, back from paternity leave since last spring. Chairman of the regional professional society.` }),
  },
  {
    key: "gender, reworded",
    reworded: true,
    a: (p) => withAbout(p, "Proud working mum who also runs the school-gate coffee rota."),
    b: (p) => withAbout(p, "Proud working dad who also runs the school-gate coffee rota."),
  },
  {
    key: "religion",
    reworded: false,
    a: (p) => withAbout(p, "Volunteer treasurer at my local church."),
    b: (p) => withAbout(p, "Volunteer treasurer at my local mosque."),
  },
  {
    key: "culture, reworded",
    reworded: true,
    a: (p) => withAbout(p, "I organise our team's Christmas charity run and keep Lent every year."),
    b: (p) => withAbout(p, "I organise our team's Eid charity run and keep Ramadan every year."),
  },
  {
    key: "age",
    reworded: false,
    a: (p) => withAbout(p, "A 58-year-old professional, born in 1967."),
    b: (p) => withAbout(p, "A 26-year-old professional, born in 1999."),
  },
  {
    key: "age, reworded",
    reworded: true,
    a: (p) => withAbout(p, "Part of the Walkman generation; I remember dial-up."),
    b: (p) => withAbout(p, "Part of the TikTok generation; I grew up with smartphones."),
  },
  {
    key: "name in the text",
    reworded: true,
    a: (p) => withAbout(p, "Friends call me Emily."),
    b: (p) => withAbout(p, "Friends call me Aisha."),
  },
]

// --- setup ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const onlyFields = args.includes("--fields") ? args[args.indexOf("--fields") + 1]!.split(",") : undefined
const corpus = buildCorpus()
const { queries } = (await Bun.file(join(root, "infra/fixtures/talent/queries.json")).json()) as {
  queries: Array<{ id: string; q: string; filters: Record<string, any>; relevance: Record<string, number> }>
}
const relevantFor = (handle: string) => queries.filter((q) => (q.relevance[handle] ?? 0) >= 2)

const postingByField = new Map<string, { index: number; by: string }>()
POSTINGS.forEach((p, index) => {
  if (!p.invalid && p.field && !postingByField.has(p.field)) postingByField.set(p.field, { index, by: p.by })
})
const bases = [...postingByField.keys()]
  .filter((f) => !onlyFields || onlyFields.includes(f))
  .map((field) => {
    const inField = corpus.filter((p) => p.field === field)
    return inField.sort((x, y) => relevantFor(y.handle).length - relevantFor(x.handle).length || x.handle.localeCompare(y.handle))[0]!
  })

async function xrpc(base: string, method: string, opts: { body?: unknown; params?: Record<string, string | Array<string>>; auth?: string } = {}) {
  const url = new URL(`/xrpc/${method}`, base)
  for (const [k, v] of Object.entries(opts.params ?? {}))
    for (const x of Array.isArray(v) ? v : [v]) url.searchParams.append(k, x)
  for (let waited = 0; ; waited += 2000) {
    const res = await fetch(url, {
      method: opts.body === undefined ? "GET" : "POST",
      headers: {
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...(opts.auth ? { authorization: opts.auth } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    // Rate limits are waited out, never worked around.
    if (res.status === 429 && waited < 180_000) {
      await Bun.sleep(2000)
      continue
    }
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }
  }
}

const suffix = Date.now().toString(36)
type Account = { handle: string; did: string; jwt: string }
const accounts: Array<Account> = []
async function createAccount(handle: string): Promise<Account> {
  const res = await xrpc(PDS, "com.atproto.server.createAccount", {
    body: { handle, email: `${handle.replace(".test", "")}@authentiq.test`, password: "password" },
  })
  if (!res.ok) throw new Error(`createAccount ${handle}: ${res.body.message}`)
  const a = { handle, did: res.body.did as string, jwt: `Bearer ${res.body.accessJwt}` }
  accounts.push(a)
  return a
}
async function signIn(handle: string): Promise<Account> {
  const res = await xrpc(PDS, "com.atproto.server.createSession", { body: { identifier: handle, password: "password" } })
  if (!res.ok) throw new Error(`${handle}: ${res.body.message} — run the seeds`)
  return { handle, did: res.body.did, jwt: `Bearer ${res.body.accessJwt}` }
}
const token = async (a: Account, lxm: string) =>
  `Bearer ${(await xrpc(PDS, "com.atproto.server.getServiceAuth", { params: { aud: APPVIEW_DID, lxm }, auth: a.jwt })).body.token}`

/** Writes a copy of `p` with `v` applied, as one commit. */
async function writeVariant(a: Account, p: Person, v: Variant) {
  const createdAt = new Date().toISOString()
  const A = sh.authentiq.actor
  const writes = [
    {
      $type: "com.atproto.repo.applyWrites#create",
      collection: A.profile.$nsid,
      rkey: "self",
      value: A.profile.$parse({ $type: A.profile.$type, ...p.profile, openToWork: true, headline: v.headline ?? p.profile.headline, about: v.about, createdAt }),
    },
    ...p.positions.map((x) => ({ $type: "com.atproto.repo.applyWrites#create", collection: A.position.$nsid, value: A.position.$parse({ $type: A.position.$type, ...x, createdAt }) })),
    ...p.education.map((x) => ({ $type: "com.atproto.repo.applyWrites#create", collection: A.education.$nsid, value: A.education.$parse({ $type: A.education.$type, ...x, createdAt }) })),
  ]
  const res = await xrpc(PDS, "com.atproto.repo.applyWrites", { body: { repo: a.did, writes }, auth: a.jwt })
  if (!res.ok) throw new Error(`${a.handle}: ${res.body.message}`)
}

const db = new SQL(`postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`)

type Pair = { base: Person; dim: Dimension; a: Account; b: Account }
const pairs: Array<Pair> = []
type Row = {
  pair: Pair
  identical: boolean
  cosine: number
  searches: Array<{ query: string; rankA?: number; rankB?: number; between?: number; scoreGap?: number }>
  bandA?: string
  bandB?: string
  similarA?: number
  similarB?: number
}
const rows: Array<Row> = []

try {
  console.log(`${bases.length} base people × ${DIMENSIONS.length} pairs = ${bases.length * DIMENSIONS.length * 2} throwaway accounts`)
  const jobs = bases.flatMap((base, i) => DIMENSIONS.map((dim, d) => ({ base, dim, i, d })))
  for (let k = 0; k < jobs.length; k += 6) {
    await Promise.all(
      jobs.slice(k, k + 6).map(async ({ base, dim, i, d }) => {
        const a = await createAccount(`cf${i}-${d}a-${suffix}.test`)
        const b = await createAccount(`cf${i}-${d}b-${suffix}.test`)
        await writeVariant(a, base, dim.a(base))
        await writeVariant(b, base, dim.b(base))
        pairs.push({ base, dim, a, b })
      })
    )
  }
  const dids = accounts.map((a) => a.did)
  const started = performance.now()
  for (;;) {
    const [row] = await db`select count(*)::int as n from embedding where subject in ${db(dids)} and vector is not null and dirty_at is null and embedded_hash = content_hash`
    if (row.n === dids.length) break
    if (performance.now() - started > EMBED_TIMEOUT_MS) throw new Error(`only ${row.n}/${dids.length} variants embedded`)
    await Bun.sleep(500)
  }
  console.log(`✓ ${dids.length} variants indexed and embedded (${Math.round(performance.now() - started)} ms)`)

  // Documents and vectors.
  const docs = new Map(
    (await db`select subject, document from embedding where subject in ${db(dids)}`).map((r: any) => [r.subject as string, r.document as string])
  )
  const cosines = new Map<string, number>()
  for (const p of pairs) {
    const [r] = await db`
      select 1 - (a.vector <=> b.vector) as cos from embedding a, embedding b
      where a.subject = ${p.a.did} and b.subject = ${p.b.did}`
    cosines.set(`${p.a.did}|${p.b.did}`, Number(r.cos))
  }

  // Everyone who is a copy of a base person: left out when ranking A and B.
  const baseDids = new Set<string>()
  for (const b of bases) {
    const r = await xrpc(PDS, "com.atproto.identity.resolveHandle", { params: { handle: b.handle } })
    if (r.ok) baseDids.add(r.body.did as string)
  }
  const copies = new Set([...dids, ...baseDids])
  /** 1 + the real people ranked above `did`; undefined if it is not in the list. */
  const poolRank = (list: Array<string>, did: string) => {
    const i = list.indexOf(did)
    return i === -1 ? undefined : 1 + list.slice(0, i).filter((d) => !copies.has(d)).length
  }

  // Postings, their authors and seeded URIs.
  const postingUri = new Map<string, string>()
  const authors = new Map<string, Account>()
  for (const [field, { index, by }] of postingByField) {
    const author = authors.get(by) ?? (await signIn(by))
    authors.set(by, author)
    postingUri.set(field, `at://${author.did}/${sh.authentiq.job.posting.$nsid}/${rkeyOf(index)}`)
  }

  // Similar candidates, once per field: the author asks.
  const similar = new Map<string, Array<string>>()
  for (const [field, { by }] of postingByField) {
    if (!bases.some((b) => b.field === field)) continue
    const res = await xrpc(APPVIEW, "sh.authentiq.job.getSimilarCandidates", {
      params: { posting: postingUri.get(field)!, limit: "20" },
      auth: await token(authors.get(by)!, "sh.authentiq.job.getSimilarCandidates"),
    })
    similar.set(field, ((res.body.candidates ?? []) as Array<any>).map((c) => c.did as string))
  }

  // Searches, once per labelled query a base person is relevant to: every
  // variant of that person is in the same result list.
  const searchCache = new Map<string, Array<{ did: string; score: number }>>()
  const search = async (q: (typeof queries)[number]) => {
    const hit = searchCache.get(q.id)
    if (hit) return hit
    const params: Record<string, string | Array<string>> = { q: q.q, mode: "hybrid", limit: "50" }
    if (q.filters.location) params.location = q.filters.location
    if (q.filters.openToWork !== undefined) params.openToWork = String(q.filters.openToWork)
    if (q.filters.skills) params.skills = q.filters.skills
    const res = await xrpc(APPVIEW, "sh.authentiq.actor.searchTalent", { params })
    const list = ((res.body.results ?? []) as Array<any>).map((r) => ({ did: r.actor.did as string, score: r.score as number }))
    searchCache.set(q.id, list)
    return list
  }

  for (const pair of pairs) {
    const row: Row = {
      pair,
      identical: docs.get(pair.a.did) === docs.get(pair.b.did),
      cosine: cosines.get(`${pair.a.did}|${pair.b.did}`) ?? Number.NaN,
      searches: [],
    }
    for (const q of relevantFor(pair.base.handle)) {
      const list = await search(q)
      const order = list.map((r) => r.did)
      const ra = poolRank(order, pair.a.did)
      const rb = poolRank(order, pair.b.did)
      const sa = list.find((r) => r.did === pair.a.did)?.score
      const sb = list.find((r) => r.did === pair.b.did)?.score
      row.searches.push({
        query: q.id,
        rankA: ra,
        rankB: rb,
        between: ra === undefined || rb === undefined ? undefined : Math.abs(ra - rb),
        scoreGap: sa === undefined || sb === undefined ? undefined : sa - sb,
      })
    }
    const posting = postingUri.get(pair.base.field)!
    for (const side of ["a", "b"] as const) {
      const acct = pair[side]
      const res = await xrpc(APPVIEW, "sh.authentiq.job.getMatch", {
        params: { posting },
        auth: await token(acct, "sh.authentiq.job.getMatch"),
      })
      const band = res.ok ? (res.body.label as string) : `error ${res.body.error}`
      const pos = poolRank(similar.get(pair.base.field) ?? [], acct.did)
      if (side === "a") {
        row.bandA = band
        row.similarA = pos
      } else {
        row.bandB = band
        row.similarB = pos
      }
    }
    rows.push(row)
  }

  // --- report ----------------------------------------------------------------------

  console.log(`\nper pair: base person, then document / cosine / search (real people between A and B, per query) / match bands / similar-candidate ranks among real people`)
  for (const r of rows) {
    const s = r.searches.map((x) => (x.between === undefined ? `${x.query}:—` : `${x.query}:${x.between}`)).join(" ")
    console.log(
      `  ${r.pair.base.handle.padEnd(13)} ${r.pair.dim.key.padEnd(18)} ${r.identical ? "identical" : "differs  "} cos ${r.cosine.toFixed(6)}  search [${s}]  match ${r.bandA}/${r.bandB}  similar ${r.similarA ?? "—"}/${r.similarB ?? "—"}`
    )
  }
  const mean = (xs: Array<number>) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN)
  console.log(
    `\nmean btw / max btw: real people ranked between A and B; similar Δ: difference in their similar-candidate positions\n${"pair".padEnd(18)} ${"docs same".padStart(9)} ${"min cos".padStart(8)} ${"searches".padStart(8)} ${"adjacent".padStart(8)} ${"mean btw".padStart(8)} ${"max btw".padStart(7)} ${"bands same".padStart(10)} ${"similar Δ".padStart(9)}`
  )
  const summarize = (subset: Array<Row>, label: string) => {
    const s = subset.flatMap((r) => r.searches).filter((x) => x.between !== undefined)
    const sim = subset.filter((r) => r.similarA !== undefined && r.similarB !== undefined).map((r) => Math.abs(r.similarA! - r.similarB!))
    const simMissing = subset.filter((r) => (r.similarA === undefined) !== (r.similarB === undefined)).length
    console.log(
      `${label.padEnd(18)} ${`${subset.filter((r) => r.identical).length}/${subset.length}`.padStart(9)} ${Math.min(...subset.map((r) => r.cosine)).toFixed(4).padStart(8)} ${String(s.length).padStart(8)} ${`${s.filter((x) => x.between === 0).length}`.padStart(8)} ${mean(s.map((x) => x.between!)).toFixed(2).padStart(8)} ${String(Math.max(0, ...s.map((x) => x.between!))).padStart(7)} ${`${subset.filter((r) => r.bandA === r.bandB).length}/${subset.length}`.padStart(10)} ${`${mean(sim).toFixed(1)}${simMissing ? ` (${simMissing} one-sided)` : ""}`.padStart(9)}`
    )
    return { s, subset }
  }
  for (const dim of DIMENSIONS) summarize(rows.filter((r) => r.pair.dim === dim), dim.key)
  const listed = summarize(rows.filter((r) => !r.pair.dim.reworded), "listed words")
  const reworded = summarize(rows.filter((r) => r.pair.dim.reworded), "reworded")
  const everything = summarize(rows, "all")
  // What redaction left in: the words that still tell A and B apart.
  const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}'’/-]+/gu) ?? [])
  const survivors = new Map<string, Set<string>>()
  for (const r of rows.filter((x) => !x.identical)) {
    const a = words(docs.get(r.pair.a.did) ?? "")
    const b = words(docs.get(r.pair.b.did) ?? "")
    const diff = [...[...a].filter((w) => !b.has(w)).map((w) => `A:${w}`), ...[...b].filter((w) => !a.has(w)).map((w) => `B:${w}`)]
    const set = survivors.get(r.pair.dim.key) ?? new Set()
    for (const w of diff) set.add(w)
    survivors.set(r.pair.dim.key, set)
  }
  if (survivors.size) {
    console.log(`\nwords left in the documents after redaction that differ between A and B:`)
    for (const [key, set] of survivors) console.log(`  ${key.padEnd(18)} ${[...set].join(" ")}`)
  }
  const bandFlips = rows.filter((r) => r.bandA !== r.bandB)
  if (bandFlips.length) {
    console.log(`\nmatch bands that differ within a pair:`)
    for (const r of bandFlips) console.log(`  ${r.pair.base.handle} ${r.pair.dim.key}: ${r.bandA} vs ${r.bandB} (cos ${r.cosine.toFixed(4)})`)
  }
  const worst = rows.flatMap((r) => r.searches.map((x) => ({ r, x }))).filter(({ x }) => (x.between ?? 0) > 0).sort((p, q) => q.x.between! - p.x.between!).slice(0, 8)
  if (worst.length) {
    console.log(`\nlargest search gaps (A = first variant in the table above):`)
    for (const { r, x } of worst)
      console.log(`  ${r.pair.base.handle} ${r.pair.dim.key.padEnd(18)} ${x.query}: A rank ${x.rankA}, B rank ${x.rankB}, ${x.between} between, score gap ${x.scoreGap}`)
  }
  // Which side gains. A is always the first variant: she/mum/church/Christmas/58/Walkman/Emily.
  const ORDER = ["weak", "partial", "strong"]
  console.log(`\ndirection (A = the first variant in the dimension table at the top of this script)`)
  console.log(`${"pair".padEnd(18)} ${"search: A ahead".padStart(16)} ${"B ahead".padStart(8)} ${"band: A higher".padStart(15)} ${"B higher".padStart(9)}`)
  for (const dim of DIMENSIONS) {
    const subset = rows.filter((r) => r.pair.dim === dim)
    const s = subset.flatMap((r) => r.searches).filter((x) => x.rankA !== undefined && x.rankB !== undefined && x.rankA !== x.rankB)
    const aHigher = subset.filter((r) => ORDER.indexOf(r.bandA!) > ORDER.indexOf(r.bandB!)).length
    const bHigher = subset.filter((r) => ORDER.indexOf(r.bandA!) < ORDER.indexOf(r.bandB!)).length
    console.log(
      `${dim.key.padEnd(18)} ${String(s.filter((x) => x.rankA! < x.rankB!).length).padStart(16)} ${String(s.filter((x) => x.rankA! > x.rankB!).length).padStart(8)} ${String(aHigher).padStart(15)} ${String(bHigher).padStart(9)}`
    )
  }
  console.log(
    `\nsummary: documents identical ${listed.subset.filter((r) => r.identical).length}/${listed.subset.length} for listed words, ${reworded.subset.filter((r) => r.identical).length}/${reworded.subset.length} reworded; searches with A and B adjacent ${everything.s.filter((x) => x.between === 0).length}/${everything.s.length}; match bands equal ${rows.filter((r) => r.bandA === r.bandB).length}/${rows.length}`
  )
} catch (err) {
  console.log(`✗ ${(err as Error).stack ?? (err as Error).message}`)
  process.exitCode = 1
} finally {
  let removed = 0
  for (const a of accounts) {
    const res = await xrpc(PDS, "com.atproto.admin.deleteAccount", { body: { did: a.did }, auth: PDS_ADMIN })
    if (res.ok) removed++
  }
  console.log(`\ncleanup: ${removed}/${accounts.length} throwaway account(s) deleted`)
  await db.close()
}
