import type { SalaryPeriod } from "@workspace/rules/salary"

/** Display names for the lexicons' knownValues. Unknown values show as written. */
export const LOCATION_LABEL: Record<string, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
}

export const EMPLOYMENT_LABEL: Record<string, string> = {
  "full-time": "Full-time",
  "part-time": "Part-time",
  contract: "Contract",
  internship: "Internship",
  freelance: "Freelance",
  volunteer: "Volunteer",
}

export const PERIOD_NAME: Record<SalaryPeriod, string> = {
  hour: "hour",
  day: "day",
  week: "week",
  month: "month",
  year: "year",
}

export const MATCH_LABEL = {
  strong: "Strong match",
  partial: "Some overlap",
  weak: "Not a close match",
} as const
