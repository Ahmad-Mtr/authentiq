import type { ActorUI } from "./social-types.ts"

/**
 * A job posting as the pages render it (phase 7): a plain, serializable
 * shape mapped from the AppView's `jobView` on the server (server/jobs.ts).
 */
export type JobUI = {
  uri: string
  author: ActorUI
  title: string
  organization: string
  description?: string
  location?: string
  locationType?: string
  employmentType?: string
  skills: Array<string>
  salary: { min: number; max: number; currency: string; period: string }
  annualSalary: { min: number; max: number }
  applyUrl?: string
  closeDate?: string
  closed: boolean
  createdAt: string
  isAuthor: boolean
  /** Author only: protected wording the matcher ignores. */
  ignoredTerms: Array<string>
}

/** Board filters, as URL search params. */
export type BoardSearch = {
  q?: string
  currency?: string
  minSalary?: number
  salaryPeriod?: string
  remote?: boolean
  locationType?: string
  location?: string
  employmentType?: string
  skills?: string
  sort?: "newest" | "salary"
  cursor?: string
}

export type MatchUI =
  | {
      state: "match"
      label: "strong" | "partial" | "weak"
      matchedSkills: Array<string>
    }
  | { state: "pending" }
  | { state: "noProfile" }

/** Route params for a posting's page, from its AT-URI. */
export function jobParams(uri: string) {
  const [, , actor, , rkey] = uri.split("/")
  return { actor: actor, rkey: rkey }
}
