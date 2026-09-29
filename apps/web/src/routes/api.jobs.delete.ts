import { createFileRoute } from "@tanstack/react-router"
import { jsonAction } from "../server/api.ts"
import { deleteJob } from "../server/jobs.ts"

/** POST `{ uri }`: delete one of the user's own postings, and wait until it leaves the board. */
export const Route = createFileRoute("/api/jobs/delete")({
  server: { handlers: { POST: jsonAction(deleteJob) } },
})
