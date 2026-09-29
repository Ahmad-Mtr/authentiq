import { createFileRoute } from "@tanstack/react-router"
import { jsonAction } from "../server/api.ts"
import { createPost } from "../server/social.ts"

/** POST `{ text, replyTo?, community?, link? }`: write a post to the user's repo. Mentions and links become facets here, at compose time. */
export const Route = createFileRoute("/api/posts")({
  server: { handlers: { POST: jsonAction(createPost) } },
})
