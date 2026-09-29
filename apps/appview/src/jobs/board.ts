import { and, desc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { findProtectedTerms } from "@workspace/rules/protected"
import { CURRENCIES, annualize, isSalaryPeriod } from "@workspace/rules/salary"
import { db } from "../db.ts"
import { loadProfileViews } from "../social/hydrate.ts"

/**
 * The job board (phase 7): `job.listPostings` and `job.getPosting`.
 *
 * Everything in `job_posting` already passed salary transparency at index
 * time, so nothing is re-checked here. What is decided at read time:
 *
 * - **Closed.** A posting whose close date has ended everywhere on Earth
 *   (`closesAt`) is left off the board. `getPosting` still returns it, marked
 *   `closed`, so a link to it explains itself.
 * - **Deactivated authors.** Their postings are not found anywhere, as in
 *   phase 6. The rows stay, so reactivation brings them back.
 * - **Currencies are never converted.** There are no exchange rates in the
 *   system, so a salary floor and the salary sort need a currency and only
 *   look at postings in it. Periods are converted, to a year, with the
 *   assumptions in @workspace/rules/salary.
 */

type JobRow = typeof schema.jobPosting.$inferSelect
type JobView = sh.authentiq.job.defs.JobView

const JOB = sh.authentiq.job

export class BoardError extends Error {}

const isClosed = (row: Pick<JobRow, "closesAt">, now = new Date()) =>
  row.closesAt !== null && row.closesAt <= now

/** Postings as views, for one viewer. Postings by inactive authors are left out. */
export async function toJobViews(
  rows: Array<JobRow>,
  viewer: string | undefined
): Promise<Array<JobView>> {
  const authors = await loadProfileViews(rows.map((r) => r.did))
  const now = new Date()
  return rows.flatMap((r) => {
    const author = authors.get(r.did)
    if (!author) return []
    const isAuthor = viewer === r.did
    const view = {
      uri: r.uri,
      cid: r.cid,
      author,
      title: r.title,
      organization: r.organization,
      description: r.description ?? undefined,
      location: r.location ?? undefined,
      locationType: r.locationType ?? undefined,
      employmentType: r.employmentType ?? undefined,
      skills: r.skills ?? undefined,
      salary: {
        min: r.salaryMin,
        max: r.salaryMax,
        currency: r.salaryCurrency,
        period: r.salaryPeriod,
      },
      annualSalary: { min: r.annualMin, max: r.annualMax },
      applyUrl: r.applyUrl ?? undefined,
      closeDate: r.closeDate ?? undefined,
      closed: isClosed(r, now),
      createdAt: r.createdAt.toISOString(),
      indexedAt: r.indexedAt.toISOString(),
      viewer: viewer
        ? {
            isAuthor,
            // Only the author is told what the matcher ignores in their text.
            ignoredTerms: isAuthor ? ignoredTermsOf(r) : undefined,
          }
        : undefined,
    }
    // Parsed through the generated schema: formats are validated, not assumed.
    return [JOB.defs.jobView.parse(view)]
  })
}

function ignoredTermsOf(r: JobRow) {
  const terms = findProtectedTerms(
    [r.title, r.description ?? "", ...(r.skills ?? [])].join("\n")
  )
  return terms.length ? terms : undefined
}

/** A posting row whose author is active, or undefined. */
export async function loadPosting(uri: string) {
  const [row] = await db
    .select({ job: schema.jobPosting })
    .from(schema.jobPosting)
    .innerJoin(schema.actor, eq(schema.actor.did, schema.jobPosting.did))
    .where(and(eq(schema.jobPosting.uri, uri), eq(schema.actor.active, true)))
  return row?.job
}

/** sh.authentiq.job.getPosting */
export async function getPosting(uri: string, viewer: string | undefined) {
  const row = await loadPosting(uri)
  if (!row) return undefined
  const [view] = await toJobViews([row], viewer)
  return view
}

export type BoardQuery = {
  q?: string
  minSalary?: number
  currency?: string
  salaryPeriod?: string
  locationType?: Array<string>
  location?: string
  employmentType?: Array<string>
  skills?: Array<string>
  /** An active actor's DID. */
  author?: string
  sort?: string
  limit: number
  cursor?: string
  viewer: string | undefined
}

/** sh.authentiq.job.listPostings. Throws BoardError for a request it cannot answer. */
export async function listPostings(opts: BoardQuery) {
  const sort = opts.sort ?? "newest"
  if (sort !== "newest" && sort !== "salary") {
    throw new BoardError(`Unknown sort ${JSON.stringify(sort)}`)
  }
  const currency = opts.currency?.trim()
  if (currency !== undefined && !CURRENCIES.has(currency)) {
    throw new BoardError(
      `Unknown currency ${JSON.stringify(currency)}: use an ISO 4217 code`
    )
  }
  if (opts.minSalary !== undefined && !currency) {
    throw new BoardError(
      "minSalary needs a currency: salaries in different currencies are not compared"
    )
  }
  if (sort === "salary" && !currency) {
    throw new BoardError(
      "sort=salary needs a currency: salaries in different currencies are not compared"
    )
  }
  const period = opts.salaryPeriod ?? "year"
  if (!isSalaryPeriod(period)) {
    throw new BoardError(`Unknown salaryPeriod ${JSON.stringify(period)}`)
  }

  const j = schema.jobPosting
  const where: Array<SQL | undefined> = [
    eq(schema.actor.active, true),
    or(isNull(j.closesAt), gt(j.closesAt, sql`now()`)),
  ]
  if (opts.q?.trim()) {
    where.push(
      sql`${j.search} @@ websearch_to_tsquery('english', ${opts.q.trim()})`
    )
  }
  if (currency) where.push(eq(j.salaryCurrency, currency))
  if (opts.minSalary !== undefined) {
    // The whole range must reach the floor: the bottom of it, per year.
    where.push(sql`${j.annualMin} >= ${annualize(opts.minSalary, period)}`)
  }
  if (opts.locationType?.length) {
    where.push(inArray(j.locationType, opts.locationType))
  }
  if (opts.employmentType?.length) {
    where.push(inArray(j.employmentType, opts.employmentType))
  }
  if (opts.location?.trim()) {
    where.push(
      ilike(j.location, `%${opts.location.trim().replace(/[\\%_]/g, "\\$&")}%`)
    )
  }
  for (const skill of opts.skills ?? []) {
    if (!skill.trim()) continue
    where.push(
      sql`exists (select 1 from unnest(${j.skills}) s where lower(s) = lower(${skill.trim()}))`
    )
  }
  if (opts.author) where.push(eq(j.did, opts.author))

  const after = decodeCursor(sort, opts.cursor)
  if (opts.cursor && !after) throw new BoardError("Invalid cursor")
  if (after?.sort === "newest") {
    where.push(
      sql`(${j.sortAt}, ${j.uri}) < (${after.sortAt.toISOString()}::timestamptz, ${after.uri})`
    )
  } else if (after?.sort === "salary") {
    where.push(
      sql`(${j.annualMin}, ${j.annualMax}, ${j.uri}) < (${after.min}, ${after.max}, ${after.uri})`
    )
  }

  const rows = await db
    .select({ job: j })
    .from(j)
    .innerJoin(schema.actor, eq(schema.actor.did, j.did))
    .where(and(...where))
    .orderBy(
      ...(sort === "salary"
        ? [desc(j.annualMin), desc(j.annualMax), desc(j.uri)]
        : [desc(j.sortAt), desc(j.uri)])
    )
    .limit(opts.limit)
  const jobs = rows.map((r) => r.job)
  const last = jobs.at(-1)
  return {
    postings: await toJobViews(jobs, opts.viewer),
    cursor:
      jobs.length === opts.limit && last ? encodeCursor(sort, last) : undefined,
  }
}

// Keyset cursors, one shape per sort order.
function encodeCursor(sort: string, r: JobRow) {
  return sort === "salary"
    ? `s:${r.annualMin}:${r.annualMax}::${r.uri}`
    : `n:${r.sortAt.getTime()}::${r.uri}`
}

function decodeCursor(sort: string, value: string | undefined) {
  if (!value) return undefined
  const i = value.indexOf("::")
  if (i < 0) return undefined
  const head = value.slice(0, i).split(":")
  const uri = value.slice(i + 2)
  if (sort === "salary" && head[0] === "s" && head.length === 3) {
    const [min, max] = [Number(head[1]), Number(head[2])]
    if (Number.isSafeInteger(min) && Number.isSafeInteger(max)) {
      return { sort: "salary" as const, min, max, uri }
    }
  }
  if (sort === "newest" && head[0] === "n" && head.length === 2) {
    const ms = Number(head[1])
    if (Number.isFinite(ms)) {
      return { sort: "newest" as const, sortAt: new Date(ms), uri }
    }
  }
  return undefined
}
