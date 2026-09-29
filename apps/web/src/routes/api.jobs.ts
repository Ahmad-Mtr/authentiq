import { createFileRoute } from "@tanstack/react-router"
import { jsonAction } from "../server/api.ts"
import { createJob } from "../server/jobs.ts"

/** POST a posting's fields: the salary rules are checked, then it is written to the user's repo. */
export const Route = createFileRoute("/api/jobs")({
  server: { handlers: { POST: jsonAction(createJob) } },
})
