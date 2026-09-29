import { createFileRoute } from "@tanstack/react-router"
import { jsonAction } from "../server/api.ts"
import { joinCommunity } from "../server/social.ts"

/** POST `{ community }`: join a community (a membership record in the user's repo). */
export const Route = createFileRoute("/api/communities/join")({
  server: { handlers: { POST: jsonAction(joinCommunity) } },
})
