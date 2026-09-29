import { createFileRoute } from "@tanstack/react-router"
import { jsonAction } from "../server/api.ts"
import { deleteOwnRecord } from "../server/social.ts"

/** POST `{ uri }`: delete one of the user's own `sh.authentiq.*` records (unlike, unfollow, leave, delete a post). */
export const Route = createFileRoute("/api/records/delete")({
  server: { handlers: { POST: jsonAction(deleteOwnRecord) } },
})
