import { createFileRoute } from "@tanstack/react-router"
import { errorResponse } from "../server/api.ts"
import { fetchDirectory } from "../server/feeds.ts"
import { getSessionAgent } from "../server/session.ts"

/** GET: every feed the AppView knows, with the signed-in user's pins marked. */
export const Route = createFileRoute("/api/feeds")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const agent = await getSessionAgent()
          return Response.json({ feeds: await fetchDirectory(agent) })
        } catch (err) {
          return errorResponse(err)
        }
      },
    },
  },
})
