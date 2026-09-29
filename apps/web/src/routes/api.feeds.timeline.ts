import { createFileRoute } from "@tanstack/react-router"
import { apiSession, errorResponse } from "../server/api.ts"
import { fetchTimeline } from "../server/feeds.ts"

/** GET `?cursor=…`: a page of the signed-in user's home timeline. */
export const Route = createFileRoute("/api/feeds/timeline")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await apiSession(request)
        if ("response" in session) return session.response
        try {
          const params = new URL(request.url).searchParams
          const page = await fetchTimeline(session.agent, {
            cursor: params.get("cursor") ?? undefined,
            limit: Number(params.get("limit") ?? 20) || 20,
          })
          return Response.json(page, { status: page.ok ? 200 : 502 })
        } catch (err) {
          return errorResponse(err)
        }
      },
    },
  },
})
