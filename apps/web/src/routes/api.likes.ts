import { createFileRoute } from "@tanstack/react-router"
import { jsonAction } from "../server/api.ts"
import { likePost } from "../server/social.ts"

/** POST `{ subject }`: like a post. */
export const Route = createFileRoute("/api/likes")({
  server: { handlers: { POST: jsonAction(likePost) } },
})
