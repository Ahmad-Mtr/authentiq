import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from "@tanstack/react-router"
import { JobForm } from "../components/jobs/job-form.tsx"
import { jobParams } from "../lib/job-types.ts"
import { getJobForEdit } from "../server/jobs-fns.ts"

export const Route = createFileRoute("/jobs/edit/$actor/$rkey")({
  loader: async ({ params }) => {
    const res = await getJobForEdit({
      data: {
        uri: `at://${params.actor}/sh.authentiq.job.posting/${params.rkey}`,
      },
    })
    if (res.state === "signedOut") throw redirect({ to: "/login" })
    return res
  },
  component: EditJob,
})

function EditJob() {
  const res = Route.useLoaderData()
  const router = useRouter()
  if (res.state !== "ok") {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-muted-foreground">
          {res.state === "notYours"
            ? "You can only edit your own postings."
            : "That posting is not in your repo."}
        </p>
      </main>
    )
  }
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-xl font-semibold">Edit posting</h1>
      <p className="mt-1 mb-8 text-sm text-muted-foreground">
        Saving replaces the record in your repo (same key) and is checked again
        before it goes back on the board.{" "}
        <Link
          to="/jobs/$actor/$rkey"
          params={jobParams(res.uri)}
          className="underline"
        >
          Cancel
        </Link>
      </p>
      <JobForm
        initial={res.values}
        uri={res.uri}
        onSaved={(uri) =>
          router.navigate({ to: "/jobs/$actor/$rkey", params: jobParams(uri) })
        }
      />
    </main>
  )
}
