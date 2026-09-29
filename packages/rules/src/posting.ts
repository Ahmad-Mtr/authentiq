import { checkSalary } from "./salary.ts"

/**
 * Business rules for `sh.authentiq.job.posting` that the lexicon cannot
 * express. The AppView indexer drops any posting that breaks one
 * (apps/appview/src/indexer/rules.ts); the web form runs the same checks.
 * Pure and browser-safe.
 */

/** `YYYY-MM-DD`, a real calendar date. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function checkCloseDate(closeDate: string | undefined) {
  if (closeDate === undefined) return undefined
  const m = DATE.exec(closeDate)
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : []
  const date = y === undefined ? undefined : new Date(Date.UTC(y, mo! - 1, d))
  if (
    !date ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo! - 1 ||
    date.getUTCDate() !== d
  ) {
    return `closeDate must be a date as YYYY-MM-DD (got ${JSON.stringify(closeDate)})`
  }
  return undefined
}

/**
 * When a posting with this close date stops taking applications: the end of
 * that day **everywhere on Earth** (Anywhere on Earth, UTC−12), i.e. noon
 * UTC the next day. A poster writes a date, not a time zone, so the board
 * keeps the posting until no one anywhere could still read that date as
 * "today". Undefined (no close date) means open until deleted.
 */
export function closesAt(closeDate: string | undefined): Date | undefined {
  if (closeDate === undefined || checkCloseDate(closeDate)) return undefined
  const [y, m, d] = closeDate.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + 1, 12))
}

/** Apply links are rendered as anchors, so only web and mail links. */
export function checkApplyUrl(url: string | undefined) {
  if (url === undefined) return undefined
  return /^(https?:\/\/|mailto:)/i.test(url)
    ? undefined
    : "applyUrl must be an http(s) or mailto: link"
}

export type PostingFields = {
  title?: unknown
  organization?: unknown
  salary?: unknown
  applyUrl?: string
  closeDate?: string
}

/**
 * Everything the lexicon cannot say about a posting, as the first reason to
 * reject it. The salary rules are in ./salary.ts.
 */
export function checkPosting(v: PostingFields): string | undefined {
  if (typeof v.title !== "string" || v.title.trim() === "") {
    return "title is blank"
  }
  if (typeof v.organization !== "string" || v.organization.trim() === "") {
    return "organization is blank"
  }
  return (
    checkSalary(v.salary) ??
    checkCloseDate(v.closeDate) ??
    checkApplyUrl(v.applyUrl)
  )
}
