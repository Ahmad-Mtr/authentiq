import { createFileRoute } from "@tanstack/react-router"
import { jsonAction } from "../server/api.ts"
import { followActor } from "../server/social.ts"

/** POST `{ subject }` (handle or DID): follow an account. */
export const Route = createFileRoute("/api/follows")({
  server: { handlers: { POST: jsonAction(followActor) } },
})
