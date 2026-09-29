import { Link, createFileRoute } from "@tanstack/react-router"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  NativeSelect,
  NativeSelectOption,
} from "@workspace/ui/components/native-select"
import { COMMON_CURRENCIES, SALARY_PERIODS } from "@workspace/rules/salary"
import { JobCard } from "../components/jobs/job-card.tsx"
import {
  EMPLOYMENT_LABEL,
  LOCATION_LABEL,
  PERIOD_NAME,
} from "../components/jobs/labels.ts"
import { boardSearch, getBoard } from "../server/jobs-fns.ts"

export const Route = createFileRoute("/jobs/")({
  validateSearch: boardSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getBoard({ data: deps }),
  component: Board,
})

/**
 * The job board. Filters are a plain GET form, so the URL is the state and
 * the page works before (and without) hydration.
 */
function Board() {
  const { postings, cursor, error, viewer } = Route.useLoaderData()
  const search = Route.useSearch()

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Jobs</h1>
        {viewer ? (
          <Link
            to="/jobs/new"
            className={buttonVariants({ size: "sm", className: "ml-auto" })}
          >
            Post a job
          </Link>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Every posting states its salary range. Postings without one are never
        shown here, whatever a client writes to its author's repo.
      </p>

      <form
        method="get"
        action="/jobs"
        className="mt-6 grid gap-3 rounded-lg border p-4 sm:grid-cols-6"
        aria-label="Filters"
      >
        <div className="grid gap-1.5 sm:col-span-3">
          <Label htmlFor="q">Keywords</Label>
          <Input
            id="q"
            name="q"
            defaultValue={search.q}
            placeholder="e.g. Terraform"
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-3">
          <Label htmlFor="skills">Skills (all of)</Label>
          <Input
            id="skills"
            name="skills"
            defaultValue={search.skills}
            placeholder="e.g. Kubernetes, Terraform"
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="currency">Currency</Label>
          <NativeSelect
            id="currency"
            name="currency"
            className="w-full"
            defaultValue={search.currency ?? ""}
          >
            <NativeSelectOption value="">Any</NativeSelectOption>
            {COMMON_CURRENCIES.map((c) => (
              <NativeSelectOption key={c} value={c}>
                {c}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="minSalary">Pays at least</Label>
          <Input
            id="minSalary"
            name="minSalary"
            inputMode="numeric"
            defaultValue={search.minSalary}
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="salaryPeriod">Per</Label>
          <NativeSelect
            id="salaryPeriod"
            name="salaryPeriod"
            className="w-full"
            defaultValue={search.salaryPeriod ?? "year"}
          >
            {SALARY_PERIODS.map((p) => (
              <NativeSelectOption key={p} value={p}>
                {PERIOD_NAME[p]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-6">
          Salaries are never converted between currencies: there are no exchange
          rates here. A pay floor and sorting by salary apply within the
          currency you pick. Pay periods are converted to a year assuming full
          time (2080 hours, 260 days, 52 weeks, 12 months), and a posting
          matches the floor when the bottom of its range reaches it.
        </p>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="locationType">Workplace</Label>
          <NativeSelect
            id="locationType"
            name="locationType"
            className="w-full"
            defaultValue={search.locationType ?? ""}
          >
            <NativeSelectOption value="">Any</NativeSelectOption>
            {Object.entries(LOCATION_LABEL).map(([v, l]) => (
              <NativeSelectOption key={v} value={v}>
                {l}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="location">Location</Label>
          <Input id="location" name="location" defaultValue={search.location} />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="employmentType">Employment</Label>
          <NativeSelect
            id="employmentType"
            name="employmentType"
            className="w-full"
            defaultValue={search.employmentType ?? ""}
          >
            <NativeSelectOption value="">Any</NativeSelectOption>
            {Object.entries(EMPLOYMENT_LABEL).map(([v, l]) => (
              <NativeSelectOption key={v} value={v}>
                {l}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="sort">Sort</Label>
          <NativeSelect
            id="sort"
            name="sort"
            className="w-full"
            defaultValue={search.sort ?? "newest"}
          >
            <NativeSelectOption value="newest">Newest</NativeSelectOption>
            <NativeSelectOption value="salary">
              Highest salary (needs a currency)
            </NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="flex items-end gap-2 sm:col-span-4">
          <Button type="submit" size="sm">
            Apply filters
          </Button>
          <Link
            to="/jobs"
            className={buttonVariants({ size: "sm", variant: "ghost" })}
          >
            Clear
          </Link>
        </div>
      </form>

      {error ? (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-6 grid gap-3" data-testid="board">
        {postings.map((job) => (
          <JobCard key={job.uri} job={job} />
        ))}
        {postings.length === 0 && !error ? (
          <p className="text-sm text-muted-foreground">No postings match.</p>
        ) : null}
      </div>
      {cursor ? (
        <Link
          to="/jobs"
          search={{ ...search, cursor }}
          className={buttonVariants({
            variant: "outline",
            size: "sm",
            className: "mt-6",
          })}
        >
          More postings
        </Link>
      ) : null}
    </main>
  )
}
