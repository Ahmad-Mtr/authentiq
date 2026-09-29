import { and, eq, sql } from "drizzle-orm"
import { schema } from "@workspace/db"
import { stripJobQuery } from "@workspace/rules/protected"
import { db } from "../db.ts"
import { hydrateProfiles, searchTalent } from "../search/talent.ts"
import { loadPosting } from "./board.ts"

/**
 * The phase 5 follow-ups for postings (phase 7).
 *
 * **Similar candidates** is for a posting's author only: the posting's
 * stored embedding searched against profile embeddings, fused (RRF) with a
 * full-text search on the posting's skills, through the same `searchTalent`
 * as talent search, so its guardrails apply: only active actors with a
 * profile, protected wording stripped (from the posting's document when it
 * was built, and from the full-text query here). By default it honours
 * `openToWork`: a posting's author did not search for anyone, so the list
 * only includes people who said they are open to work. Candidates come in
 * rank order with no score, because a score would be one person's match
 * shown to someone else.
 *
 * **Match score** is for a signed-in person about themselves: the cosine
 * similarity of their profile document and the posting's, reported as a
 * coarse band (`MATCH_BANDS`), never as a number. The caller is always the
 * service-auth issuer; there is no way to ask about another person.
 */

export type MatchError = { error: string; message: string; status: number }

const notFound = (uri: string): MatchError => ({
  status: 400,
  error: "PostingNotFound",
  message: `Posting not found: ${uri}`,
})

/** A subject's stored embedding, if it has one yet. */
export async function vectorOf(subject: string) {
  const [row] = await db
    .select({ vector: schema.embedding.vector })
    .from(schema.embedding)
    .where(eq(schema.embedding.subject, subject))
  return row?.vector ?? undefined
}

/**
 * The full-text half of the hybrid: the posting's skills, which is where
 * exact matching beats vectors (phase 5 eval, exact-skill queries: FTS 0.975
 * vs vector 0.765). Title words like "Senior" or "Engineer" would match half
 * the corpus, so the title is used only when there are no skills. Protected
 * wording is stripped, as from the posting's document.
 */
export function ftsQueryFor(job: {
  title: string
  skills: Array<string> | null
}) {
  const words = job.skills?.length ? job.skills.join(", ") : job.title
  return stripJobQuery(words).text
}

/** Candidates for the author's own posting. */
export async function similarCandidates(opts: {
  posting: string
  caller: string
  limit: number
  /** Honour openToWork (the default for similar candidates). */
  openToWorkOnly?: boolean
}) {
  const job = await loadPosting(opts.posting)
  if (!job) return notFound(opts.posting)
  if (job.did !== opts.caller) {
    return {
      status: 403,
      error: "NotPostingAuthor",
      message: "Only a posting's author can see similar candidates",
    } satisfies MatchError
  }
  const vector = await vectorOf(job.uri)
  if (!vector) return { candidates: [], pending: true }
  const result = await searchTalent({
    q: ftsQueryFor(job),
    vector,
    filters: {
      openToWork: (opts.openToWorkOnly ?? true) ? true : undefined,
      exclude: [job.did],
    },
    limit: opts.limit,
  })
  const profiles = await hydrateProfiles(result.hits.map((h) => h.did))
  return {
    candidates: result.hits.flatMap((h) => {
      const p = profiles.get(h.did)
      return p
        ? [{ view: p.view, skills: p.skills, matchedBy: h.matchedBy }]
        : []
    }),
    pending: false,
  }
}

/**
 * Bands of cosine similarity between a profile document and a posting
 * document (mistral-embed). Chosen from the distribution over the talent
 * corpus and the seeded postings: see the phase 7 doc, "Match score". A
 * label, not a percentage: the similarity of two embeddings is not a
 * probability of anything, and two decimals would claim a precision it
 * does not have.
 */
export const MATCH_BANDS = { strong: 0.84, partial: 0.8 } as const

export const matchLabel = (similarity: number) =>
  similarity >= MATCH_BANDS.strong
    ? "strong"
    : similarity >= MATCH_BANDS.partial
      ? "partial"
      : "weak"

/** How the caller's own profile matches a posting. */
export async function matchFor(opts: { posting: string; caller: string }) {
  const job = await loadPosting(opts.posting)
  if (!job) return notFound(opts.posting)
  const [actor] = await db
    .select({ active: schema.actor.active, skills: schema.profile.skills })
    .from(schema.actor)
    .innerJoin(schema.profile, eq(schema.profile.did, schema.actor.did))
    .where(eq(schema.actor.did, opts.caller))
  if (!actor?.active) {
    return {
      status: 400,
      error: "ProfileNotFound",
      message: "Add a profile to see how you match",
    } satisfies MatchError
  }
  const [positions, similarity] = await Promise.all([
    db
      .select({ skills: schema.position.skills })
      .from(schema.position)
      .where(eq(schema.position.did, opts.caller)),
    db
      .select({
        value: sql<
          number | null
        >`1 - (${schema.embedding.vector} <=> (select vector from embedding where subject = ${job.uri}))`,
      })
      .from(schema.embedding)
      .where(
        and(
          eq(schema.embedding.subject, opts.caller),
          sql`${schema.embedding.vector} is not null`,
          sql`exists (select 1 from embedding where subject = ${job.uri} and vector is not null)`
        )
      ),
  ])
  const mine = new Set(
    [...(actor.skills ?? []), ...positions.flatMap((p) => p.skills ?? [])].map(
      (s) => s.toLowerCase()
    )
  )
  const matchedSkills = (job.skills ?? []).filter((s) =>
    mine.has(s.toLowerCase())
  )
  const value = similarity[0]?.value
  if (value === undefined || value === null) {
    return { posting: job.uri, matchedSkills, pending: true }
  }
  return {
    posting: job.uri,
    label: matchLabel(Number(value)),
    matchedSkills,
  }
}
