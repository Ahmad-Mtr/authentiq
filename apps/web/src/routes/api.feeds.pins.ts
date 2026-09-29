import { createFileRoute } from "@tanstack/react-router"
import { apiSession, errorResponse, jsonAction } from "../server/api.ts"
import { fetchPinned, setPinned } from "../server/feeds.ts"

/**
 * GET: the signed-in user's pinned feeds, in order.
 * POST `{ feed, pinned }`: pin or unpin one feed.
 *
 * Pins are private AppView state behind service auth, not a record in the
 * user's repo: see the phase 8 doc.
 */
export const Route = createFileRoute("/api/feeds/pins")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await apiSession(request)
        if ("response" in session) return session.response
        try {
          return Response.json({ feeds: await fetchPinned(session.agent) })
        } catch (err) {
          return errorResponse(err)
        }
      },
      POST: jsonAction(setPinned),
    },
  },
})
