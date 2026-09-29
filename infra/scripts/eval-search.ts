/**
 * Talent search relevance (phase 5): runs every hand-labelled query in
 * infra/fixtures/talent/queries.json through the live
 * `sh.authentiq.actor.searchTalent` endpoint in each mode (vector, fts,
 * hybrid), and reports per query and overall:
 *
 *   nDCG@10   graded gain 2^rel − 1, log2 discount; the ideal ranking is every
 *             labelled person for the query, best first.
 *   recall@10 share of the query's relevant people (grade ≥ 2) in the top 10.
 *   MRR       1 / rank of the first relevant (grade ≥ 2) result, 0 if none.
 *
 * Unlabelled people count as grade 0. Needs the corpus (`bun run seed:talent`)
 * and the AppView running. The endpoint is rate limited (60 a minute per IP);
 * the script waits out a 429 rather than going around it.
 *
 *   bun run eval:search
 *   bun run eval:search -- --verbose   # also print each query's top 10
 */
import { join } from "node:path"
import { LOCAL_NETWORK } from "@workspace/atproto"

const APPVIEW = process.env.APPVIEW_URL ?? LOCAL_NETWORK.appviewUrl
const K = 10
const MODES = ["vector", "fts", "hybrid"] as const
type Mode = (typeof MODES)[number]
const verbose = process.argv.includes("--verbose")

type Query = {
  id: string
  type: string
  q: string
  filters: { location?: string; openToWork?: boolean; skills?: Array<string> }
  relevance: Record<string, number>
}
const { queries } = (await Bun.file(
  join(import.meta.dir, "..", "fixtures", "talent", "queries.json")
).json()) as { queries: Array<Query> }

const health = (await fetch(`${APPVIEW}/xrpc/_health`)
  .then((r) => r.json())
  .catch(() => null)) as { embedder?: { pending: number } } | null
if (!health) {
  console.log(`✗ AppView not reachable at ${APPVIEW} (bun run dev)`)
  process.exit(1)
}
if (health.embedder?.pending) {
  console.log(
    `✗ ${health.embedder.pending} embedding(s) still pending; wait, or run bun run seed:talent`
  )
  process.exit(1)
}

async function search(query: Query, mode: Mode) {
  const url = new URL("/xrpc/sh.authentiq.actor.searchTalent", APPVIEW)
  url.searchParams.set("q", query.q)
  url.searchParams.set("mode", mode)
  url.searchParams.set("limit", String(K))
  if (query.filters.location)
    url.searchParams.set("location", query.filters.location)
  if (query.filters.openToWork !== undefined) {
    url.searchParams.set("openToWork", String(query.filters.openToWork))
  }
  for (const s of query.filters.skills ?? [])
    url.searchParams.append("skills", s)
  for (let waited = 0; ; waited += 2000) {
    const res = await fetch(url)
    if (res.status === 429 && waited < 120_000) {
      await Bun.sleep(2000)
      continue
    }
    if (!res.ok)
      throw new Error(`${query.id} ${mode}: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as {
      results: Array<{ actor: { handle: string }; matchedBy: Array<string> }>
      degraded?: boolean
    }
    if (body.degraded)
      throw new Error(`${query.id}: search degraded (embedding API down?)`)
    return body.results.map((r) => ({
      handle: r.actor.handle,
      matchedBy: r.matchedBy,
    }))
  }
}

const dcg = (gains: Array<number>) =>
  gains
    .slice(0, K)
    .reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0)

function metrics(query: Query, handles: Array<string>) {
  const grade = (h: string) => query.relevance[h] ?? 0
  const ideal = dcg(Object.values(query.relevance).sort((a, b) => b - a))
  const ndcg = ideal === 0 ? 0 : dcg(handles.map(grade)) / ideal
  const relevant = Object.keys(query.relevance).filter((h) => grade(h) >= 2)
  const top = handles.slice(0, K)
  const recall =
    relevant.length === 0
      ? 1
      : relevant.filter((h) => top.includes(h)).length / relevant.length
  const first = top.findIndex((h) => grade(h) >= 2)
  return { ndcg, recall, mrr: first === -1 ? 0 : 1 / (first + 1) }
}

type Row = {
  query: Query
  scores: Record<Mode, ReturnType<typeof metrics>>
  hybridOnlyOne: number
}
const rows: Array<Row> = []
const fmt = (n: number) => n.toFixed(3)

console.log(`${queries.length} queries, k = ${K}, RRF k = 60\n`)
console.log(
  `${"id".padEnd(4)} ${"type".padEnd(9)} ${"nDCG@10 vector".padStart(14)} ${"fts".padStart(6)} ${"hybrid".padStart(7)}   query`
)
for (const query of queries) {
  const scores = {} as Row["scores"]
  let hybridOnlyOne = 0
  for (const mode of MODES) {
    const results = await search(query, mode)
    scores[mode] = metrics(
      query,
      results.map((r) => r.handle)
    )
    if (mode === "hybrid") {
      hybridOnlyOne = results.filter((r) => r.matchedBy.length === 1).length
    }
    if (verbose) {
      console.log(
        `     ${mode.padEnd(6)} ${results
          .map(
            (r) =>
              `${r.handle.slice(4, 7)}${query.relevance[r.handle] ? `(${query.relevance[r.handle]})` : ""}`
          )
          .join(" ")}`
      )
    }
  }
  rows.push({ query, scores, hybridOnlyOne })
  const best = Math.max(...MODES.map((m) => scores[m].ndcg))
  const cell = (m: Mode, w: number) =>
    `${scores[m].ndcg === best ? "*" : " "}${fmt(scores[m].ndcg)}`.padStart(w)
  console.log(
    `${query.id.padEnd(4)} ${query.type.padEnd(9)} ${cell("vector", 14)} ${cell("fts", 6)} ${cell("hybrid", 7)}   ${query.q}${
      Object.keys(query.filters).length
        ? ` ${JSON.stringify(query.filters)}`
        : ""
    }`
  )
}

const mean = (xs: Array<number>) =>
  xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
console.log(`\n* = best for that query (ties marked on each)\n`)
console.log(
  `${"".padEnd(16)} ${"vector".padStart(8)} ${"fts".padStart(8)} ${"hybrid".padStart(8)}`
)
for (const [label, metric] of [
  ["nDCG@10", "ndcg"],
  ["recall@10", "recall"],
  ["MRR", "mrr"],
] as const) {
  console.log(
    `${`${label} (all)`.padEnd(16)} ${MODES.map((m) => fmt(mean(rows.map((r) => r.scores[m][metric]))).padStart(8)).join(" ")}`
  )
}
console.log("")
for (const type of [...new Set(queries.map((q) => q.type))]) {
  const subset = rows.filter((r) => r.query.type === type)
  console.log(
    `${`nDCG@10 ${type}`.padEnd(16)} ${MODES.map((m) => fmt(mean(subset.map((r) => r.scores[m].ndcg))).padStart(8)).join(" ")}   (${subset.length} queries)`
  )
}
const wins = (m: Mode) =>
  rows.filter((r) => MODES.every((o) => r.scores[m].ndcg >= r.scores[o].ndcg))
    .length
console.log(
  `\nbest or tied-best: vector ${wins("vector")}, fts ${wins("fts")}, hybrid ${wins("hybrid")} of ${rows.length}`
)
console.log(
  `hybrid results found by only one retriever: ${rows.reduce((a, r) => a + r.hybridOnlyOne, 0)} of ${rows.length * K} slots`
)
