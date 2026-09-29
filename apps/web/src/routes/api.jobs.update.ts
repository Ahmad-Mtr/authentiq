import { createFileRoute } from "@tanstack/react-router"
import { jsonAction } from "../server/api.ts"
import { updateJob } from "../server/jobs.ts"

/** POST `{ uri, ...fields }`: re-validate and `putRecord` one of the user's own postings, same key. */
export const Route = createFileRoute("/api/jobs/update")({
  server: { handlers: { POST: jsonAction(updateJob) } },
})
