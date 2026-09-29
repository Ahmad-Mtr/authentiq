import {
  Link,
  createFileRoute,
  notFound,
  useRouter,
} from "@tanstack/react-router"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Separator } from "@workspace/ui/components/separator"
import { formatSalary } from "@workspace/rules/salary"
import { useState } from "react"
import {
  EMPLOYMENT_LABEL,
  LOCATION_LABEL,
  MATCH_LABEL,
} from "../components/jobs/labels.ts"
import { usePolled } from "../components/jobs/use-polled.ts"
import { postJson } from "../lib/actions.ts"
import type { JobUI, MatchUI } from "../lib/job-types.ts"
import { jobParams } from "../lib/job-types.ts"
import type { ActorUI } from "../lib/social-types.ts"
import { getJobPage } from "../server/jobs-fns.ts"

export const Route = createFileRoute("/jobs/$actor/$rkey")({
  loader: async ({ params }) => {
    const page = await getJobPage({
      data: {
        uri: `at://${params.actor}/sh.authentiq.job.posting/${params.rkey}`,
      },
    })
    if (!page.job) throw notFound()
    return { job: page.job, viewer: page.viewer }
  },
  component: JobPage,
})

function JobPage() {
  const { job, viewer } = Route.useLoaderData()
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        to="/jobs"
        className="text-sm text-muted-foreground hover:underline"
      >
        ← Jobs
      </Link>
      {job.closed ? (
        <Alert className="mt-4" data-testid="closed">
          <AlertTitle>This posting has closed</AlertTitle>
          <AlertDescription>
            Applications closed on {job.closeDate}. It is no longer on the
            board.
          </AlertDescription>
        </Alert>
      ) : null}
      <header className="mt-4">
        <h1 className="text-2xl font-semibold" dir="auto">
          {job.title}
        </h1>
        <p className="text-muted-foreground" dir="auto">
          {job.organization}
          {job.location ? ` · ${job.location}` : ""}
        </p>
        <p className="mt-3 text-lg font-medium" data-testid="salary">
          {formatSalary(job.salary)}
        </p>
        {job.salary.period !== "year" ? (
          <p className="text-xs text-muted-foreground">
            ≈ {job.salary.currency} {job.annualSalary.min.toLocaleString("en")}–
            {job.annualSalary.max.toLocaleString("en")} a year, assuming full
            time
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-1.5">
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
          {job.closeDate && !job.closed ? (
            <Badge variant="outline">Apply by {job.closeDate}</Badge>
          ) : null}
        </div>
        {job.applyUrl && !job.closed ? (
          <a
            href={job.applyUrl}
            rel="noopener noreferrer nofollow"
            target="_blank"
            className={buttonVariants({ className: "mt-4" })}
          >
            Apply
          </a>
        ) : null}
      </header>

      {job.description ? (
        <p
          className="mt-6 text-sm leading-relaxed whitespace-pre-line"
          dir="auto"
        >
          {job.description}
        </p>
      ) : null}
      {job.skills.length ? (
        <ul className="mt-6 flex flex-wrap gap-2">
          {job.skills.map((s) => (
            <li key={s} className="rounded-md bg-muted px-2 py-1 text-xs">
              {s}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-6 text-xs text-muted-foreground">
        Posted by{" "}
        <Link
          to="/p/$actor"
          params={{ actor: job.author.did }}
          className="underline"
        >
          {job.author.displayName ?? job.author.handle}
        </Link>{" "}
        on {job.createdAt.slice(0, 10)}. Who is hiring is as the poster states
        it; Authentiq does not verify it.
      </p>

      {viewer && !job.isAuthor ? (
        <MatchPanel key={job.uri} uri={job.uri} />
      ) : null}

      {job.isAuthor ? (
        <>
          <Separator className="my-8" />
          <section data-testid="author-tools">
            <h2 className="font-medium">Your posting</h2>
            {job.ignoredTerms.length ? (
              <Alert className="mt-3" data-testid="protected-wording">
                <AlertTitle>Some wording is ignored for matching</AlertTitle>
                <AlertDescription>
                  {job.ignoredTerms.map((t) => `“${t}”`).join(", ")}{" "}
                  {job.ignoredTerms.length === 1 ? "refers" : "refer"} to a
                  protected attribute such as age or national origin, so it has
                  no effect on who is suggested below. Only you see this note.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="mt-3 flex gap-2">
              <Link
                to="/jobs/edit/$actor/$rkey"
                params={jobParams(job.uri)}
                className={buttonVariants({ size: "sm", variant: "outline" })}
              >
                Edit
              </Link>
              <Button
                size="sm"
                variant="destructive"
                disabled={deleting}
                onClick={() => {
                  if (!window.confirm("Delete this posting from your repo?"))
                    return
                  setDeleting(true)
                  postJson("/api/jobs/delete", { uri: job.uri })
                    .then(() => router.navigate({ to: "/jobs" }))
                    .catch(() => setDeleting(false))
                }}
              >
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            </div>
            <SimilarCandidates key={job.uri} job={job} />
          </section>
        </>
      ) : null}
    </main>
  )
}

/** The viewer's own match: fetched for them, shown only to them. */
function MatchPanel({ uri }: { uri: string }) {
  const match = usePolled<MatchUI>(
    `/api/jobs/match?posting=${encodeURIComponent(uri)}`,
    (m) => m.state === "pending"
  )

  return (
    <section className="mt-8 rounded-lg border p-4" data-testid="match">
      <h2 className="text-sm font-medium">How your profile matches</h2>
      {match === null ? (
        <p className="mt-1 text-sm text-muted-foreground">Checking…</p>
      ) : match === "error" ? (
        <p className="mt-1 text-sm text-muted-foreground">
          Not available right now.
        </p>
      ) : match.state === "noProfile" ? (
        <p className="mt-1 text-sm text-muted-foreground">
          <Link to="/profile/edit" className="underline">
            Add a profile
          </Link>{" "}
          to see how you match.
        </p>
      ) : match.state === "pending" ? (
        <p className="mt-1 text-sm text-muted-foreground">
          Still processing; check back in a moment.
        </p>
      ) : (
        <>
          <p className="mt-1 text-lg font-medium" data-label={match.label}>
            {MATCH_LABEL[match.label]}
          </p>
          {match.matchedSkills.length ? (
            <p className="text-sm text-muted-foreground">
              Skills you list that it asks for: {match.matchedSkills.join(", ")}
            </p>
          ) : null}
        </>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Compares your public profile with this posting's description. A rough
        band, not a score, and only you can see it.
      </p>
    </section>
  )
}

type Candidate = ActorUI & { location?: string }

/** People like this posting, for its author. Rank order only; no scores. */
function SimilarCandidates({ job }: { job: JobUI }) {
  const state = usePolled<{ candidates: Array<Candidate>; pending: boolean }>(
    `/api/jobs/similar?posting=${encodeURIComponent(job.uri)}`,
    (s) => s.pending
  )

  return (
    <div className="mt-6" data-testid="similar">
      <h3 className="text-sm font-medium">Similar candidates</h3>
      <p className="text-xs text-muted-foreground">
        People whose public profiles resemble this posting, among those who say
        they are open to work. Only you see this list.
      </p>
      {state === null ? (
        <p className="mt-2 text-sm text-muted-foreground">Looking…</p>
      ) : state === "error" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Not available right now.
        </p>
      ) : state.pending ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Still processing this posting; check back in a moment.
        </p>
      ) : state.candidates.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No one yet.</p>
      ) : (
        <ol className="mt-2 grid gap-2">
          {state.candidates.map((c) => (
            <li key={c.did} className="text-sm">
              <Link
                to="/p/$actor"
                params={{ actor: c.did }}
                className="font-medium hover:underline"
              >
                {c.displayName ?? c.handle}
              </Link>
              {c.headline ? (
                <span className="text-muted-foreground"> · {c.headline}</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
