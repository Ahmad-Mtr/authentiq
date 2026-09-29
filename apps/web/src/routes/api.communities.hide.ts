import { createFileRoute } from "@tanstack/react-router"
import { jsonAction } from "../server/api.ts"
import { setPostHidden } from "../server/social.ts"

/** POST `{ community, post, hidden }`: hide or unhide a post in a community the user created. */
export const Route = createFileRoute("/api/communities/hide")({
  server: { handlers: { POST: jsonAction(setPostHidden) } },
})
