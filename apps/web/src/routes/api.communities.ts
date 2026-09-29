import { createFileRoute } from "@tanstack/react-router"
import { jsonAction } from "../server/api.ts"
import { createCommunity } from "../server/social.ts"

/** POST `{ name, topic, description?, rules? }`: create a community. */
export const Route = createFileRoute("/api/communities")({
  server: { handlers: { POST: jsonAction(createCommunity) } },
})
