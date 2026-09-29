import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { closesAt } from "@workspace/rules/posting"
import { annualize, isSalaryPeriod } from "@workspace/rules/salary"
import { defineCollection } from "./collections.ts"
import { checkJobPosting } from "./rules.ts"

/**
 * Phase 7: `sh.authentiq.job.posting`. Validation is the lexicon (which
 * requires `salary`), the record key, then `checkJobPosting`. Postings are
 * editable: an update is validated again, and one that breaks a rule (say,
 * an edit that drops the salary) removes the indexed version.
 *
 * Each posting is its own search subject (`job`, keyed by URI), embedded by
 * the phase 5 worker for similar candidates and match scores.
 */

/** Board order never trusts a createdAt in the future. */
const sortAt = (createdAt: string) =>
  new Date(Math.min(Date.parse(createdAt), Date.now()))

export const posting = defineCollection({
  schema: sh.authentiq.job.posting,
  table: schema.jobPosting,
  rules: (v) => checkJobPosting(v),
  embeds: (ref) => ({ kind: "job", subject: ref.uri }),
  toRow: (v) => {
    const { min, max, currency, period } = v.salary
    // checkJobPosting has already refused unknown periods.
    const p = isSalaryPeriod(period) ? period : "year"
    return {
      title: v.title,
      organization: v.organization,
      description: v.description,
      location: v.location,
      locationType: v.locationType,
      employmentType: v.employmentType,
      skills: v.skills,
      salaryMin: min,
      salaryMax: max,
      salaryCurrency: currency,
      salaryPeriod: p,
      annualMin: annualize(min, p),
      annualMax: annualize(max, p),
      applyUrl: v.applyUrl,
      closeDate: v.closeDate,
      closesAt: closesAt(v.closeDate) ?? null,
      searchText: [v.title, v.organization, v.description, ...(v.skills ?? [])]
        .filter(Boolean)
        .join("\n"),
      createdAt: new Date(v.createdAt),
      sortAt: sortAt(v.createdAt),
    }
  },
})
