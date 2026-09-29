import { createFileRoute, redirect, useRouter } from "@tanstack/react-router"
import { EMPTY_JOB, JobForm } from "../components/jobs/job-form.tsx"
import { jobParams } from "../lib/job-types.ts"
import { getViewer } from "../server/profile.ts"

export const Route = createFileRoute("/jobs/new")({
  loader: async () => {
    const viewer = await getViewer()
    if (!viewer) throw redirect({ to: "/login" })
    return viewer
  },
  component: NewJob,
})

function NewJob() {
  const router = useRouter()
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-xl font-semibold">Post a job</h1>
      <p className="mt-1 mb-8 text-sm text-muted-foreground">
        The posting is a record in your own repo. It appears on the board once
        Authentiq has checked its salary range, and you can edit or delete it at
        any time.
      </p>
      <JobForm
        initial={EMPTY_JOB}
        onSaved={(uri) =>
          router.navigate({ to: "/jobs/$actor/$rkey", params: jobParams(uri) })
        }
      />
    </main>
  )
}
