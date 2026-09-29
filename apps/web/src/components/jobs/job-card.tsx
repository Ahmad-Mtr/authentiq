import { Link } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { formatSalary } from "@workspace/rules/salary"
import type { JobUI } from "../../lib/job-types.ts"
import { jobParams } from "../../lib/job-types.ts"
import { EMPLOYMENT_LABEL, LOCATION_LABEL } from "./labels.ts"

/** One posting on the board. The salary is always shown: there is no posting without one. */
export function JobCard({ job }: { job: JobUI }) {
  return (
    <article className="rounded-lg border p-4" data-uri={job.uri}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Link
          to="/jobs/$actor/$rkey"
          params={jobParams(job.uri)}
          className="font-medium hover:underline"
          dir="auto"
        >
          {job.title}
        </Link>
        <span className="text-sm text-muted-foreground" dir="auto">
          · {job.organization}
        </span>
      </div>
      <p className="mt-1 text-sm font-medium" data-testid="salary">
        {formatSalary(job.salary)}
        {job.salary.period !== "year" ? (
          <span className="font-normal text-muted-foreground">
            {" "}
            (≈ {job.salary.currency} {job.annualSalary.min.toLocaleString("en")}
            –{job.annualSalary.max.toLocaleString("en")} a year)
          </span>
        ) : null}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {job.locationType ? (
          <Badge variant="secondary">
            {LOCATION_LABEL[job.locationType] ?? job.locationType}
          </Badge>
        ) : null}
        {job.employmentType ? (
          <Badge variant="outline">
            {EMPLOYMENT_LABEL[job.employmentType] ?? job.employmentType}
          </Badge>
        ) : null}
        {job.location ? (
          <span
            className="self-center text-xs text-muted-foreground"
            dir="auto"
          >
            {job.location}
          </span>
        ) : null}
      </div>
      {job.skills.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {job.skills.join(" · ")}
        </p>
      ) : null}
    </article>
  )
}
