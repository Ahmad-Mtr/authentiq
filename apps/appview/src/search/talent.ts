import { inArray, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { db } from "../db.ts"
import { stripQuery } from "../embed/protected.ts"
import { embedQuery } from "../embed/query.ts"

/**
 * Talent search: the code behind `sh.authentiq.actor.searchTalent` and the
 * agent's `search_talent` tool.
 *
 *   vector: cosine distance between the query's embedding and each profile
 *           document's (pgvector HNSW, iterative scan so filters don't
 *           starve the result).
 *   fts:    Postgres full-text search over the same document, English
 *           stemming; query terms are OR-ed and ranked by ts_rank_cd, so a
 *           long query still matches documents that share some of its words.
 *   hybrid: both, fused with Reciprocal Rank Fusion:
 *             score(d) = Σ over retrievers r that returned d of 1 / (k + rank_r(d))
 *           with k = 60 (the value from Cormack et al., not tuned here).
 *
 * Filters are applied inside each retriever's SQL, not after fusion, so each
 * one ranks only eligible actors. Only active actors with an indexed profile
 * record (public repo data) are ever candidates. Protected-attribute terms
 * are removed from the query before either retriever sees it
 * (./embed/protected.ts), and never reach the documents either.
 */

export const RRF_K = 60
/**
 * How deep each retriever looks before fusion; pages come from this pool.
 * Keep it well below the number of searchable actors, or the vector list is
 * the whole corpus and "matched by vector" means nothing. (It was 100 for the
 * first eval run, against an 85-person corpus; see the phase 5 doc.)
 */
export const CANDIDATES = 50

export type TalentMode = "hybrid" | "vector" | "fts"
export type TalentFilters = {
  openToWork?: boolean
  location?: string
  skills?: Array<string>
}
export type TalentHit = {
  did: string
  score: number
  vectorRank?: number
  ftsRank?: number
  matchedBy: Array<"vector" | "fts">
}

export class SearchUnavailableError extends Error {}

export async function searchTalent(opts: {
  q: string
  filters?: TalentFilters
  mode?: TalentMode
  limit?: number
  offset?: number
}) {
  const mode = opts.mode ?? "hybrid"
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50)
  const offset = Math.min(Math.max(opts.offset ?? 0, 0), CANDIDATES)
  const { text, removed } = stripQuery(opts.q)
  const where = filterSql(opts.filters ?? {})

  let vectorDids: Array<string> = []
  let ftsDids: Array<string> = []
  let degraded = false

  if (text) {
    const [v, f] = await Promise.all([
      mode === "fts"
        ? []
        : vectorRetriever(text, where).catch((err: unknown) => {
            // The model is down or slow. Hybrid degrades to full-text only;
            // vector-only has nothing to fall back on.
            if (mode === "vector")
              throw new SearchUnavailableError((err as Error).name)
            degraded = true
            return []
          }),
      mode === "vector" ? [] : ftsRetriever(text, where),
    ])
    vectorDids = v
    ftsDids = f
  }

  const fused = new Map<string, TalentHit>()
  const add = (dids: Array<string>, retriever: "vector" | "fts") =>
    dids.forEach((did, i) => {
      const hit = fused.get(did) ?? { did, score: 0, matchedBy: [] }
      hit.score += 1 / (RRF_K + i + 1)
      hit[retriever === "vector" ? "vectorRank" : "ftsRank"] = i + 1
      hit.matchedBy.push(retriever)
      fused.set(did, hit)
    })
  add(vectorDids, "vector")
  add(ftsDids, "fts")

  const ranked = [...fused.values()].sort(
    (a, b) =>
      b.score - a.score ||
      Math.min(a.vectorRank ?? Infinity, a.ftsRank ?? Infinity) -
        Math.min(b.vectorRank ?? Infinity, b.ftsRank ?? Infinity) ||
      (a.did < b.did ? -1 : 1)
  )
  const page = ranked.slice(offset, offset + limit)
  return {
    effectiveQuery: text,
    ignoredTerms: removed,
    degraded,
    hits: page,
    nextOffset: offset + limit < ranked.length ? offset + limit : undefined,
  }
}

function filterSql(f: TalentFilters): SQL {
  const parts: Array<SQL> = [sql`a.active`, sql`e.kind = 'actor'`]
  if (f.openToWork !== undefined) {
    parts.push(sql`coalesce(p.open_to_work, false) = ${f.openToWork}`)
  }
  if (f.location?.trim()) {
    const like = `%${f.location.trim().replace(/[\\%_]/g, "\\$&")}%`
    parts.push(sql`p.location ilike ${like}`)
  }
  for (const skill of f.skills ?? []) {
    if (!skill.trim()) continue
    parts.push(
      sql`exists (select 1 from unnest(p.skills) s where lower(s) = lower(${skill.trim()}))`
    )
  }
  return sql.join(parts, sql` and `)
}

async function vectorRetriever(
  text: string,
  where: SQL
): Promise<Array<string>> {
  const vector = JSON.stringify(await embedQuery(text))
  return db.transaction(async (tx) => {
    // Filters apply after the HNSW scan; iterative scans keep reading the
    // index until enough rows pass them (pgvector ≥ 0.8).
    await tx.execute(sql`set local hnsw.iterative_scan = strict_order`)
    await tx.execute(sql`set local hnsw.ef_search = 100`)
    const rows = await tx.execute<{ did: string }>(sql`
      select e.subject as did
      from embedding e
      join actor a on a.did = e.did
      join profile p on p.did = e.did
      where e.vector is not null and ${where}
      order by e.vector <=> ${vector}::vector
      limit ${CANDIDATES}`)
    return rows.map((r) => r.did)
  })
}

async function ftsRetriever(text: string, where: SQL): Promise<Array<string>> {
  // websearch_to_tsquery parses the text safely (no syntax errors from user
  // input), stems it and ANDs the terms; swapping & for | makes it an OR
  // query. The result is cast straight back to tsquery: running it through
  // to_tsquery('english', …) would stem the stems again ('nurs' → 'nur').
  const rows = await db.execute<{ did: string }>(sql`
    with q as (
      select replace(websearch_to_tsquery('english', ${text})::text, ' & ', ' | ')::tsquery as query
    )
    select e.subject as did
    from embedding e
    join actor a on a.did = e.did
    join profile p on p.did = e.did
    cross join q
    where e.search @@ q.query and ${where}
    order by ts_rank_cd(e.search, q.query, 1) desc, e.subject
    limit ${CANDIDATES}`)
  return rows.map((r) => r.did)
}

export type TalentProfile = {
  view: sh.authentiq.actor.defs.ProfileView
  skills: Array<string>
}

/** `profileView`s (plus skills, for the agent) for a page of hits. */
export async function hydrateProfiles(
  dids: Array<string>
): Promise<Map<string, TalentProfile>> {
  if (dids.length === 0) return new Map()
  const rows = await db
    .select({ actor: schema.actor, profile: schema.profile })
    .from(schema.actor)
    .innerJoin(schema.profile, sql`${schema.profile.did} = ${schema.actor.did}`)
    .where(inArray(schema.actor.did, dids))
  return new Map(
    rows.map(({ actor, profile }) => [
      actor.did,
      {
        view: sh.authentiq.actor.defs.profileView.parse({
          did: actor.did,
          handle: actor.handle ?? "handle.invalid",
          displayName: profile.displayName,
          headline: profile.headline ?? undefined,
          location: profile.location ?? undefined,
          openToWork: profile.openToWork ?? undefined,
          indexedAt: profile.indexedAt.toISOString(),
        }),
        skills: profile.skills ?? [],
      },
    ])
  )
}
