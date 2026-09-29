import { createFileRoute } from "@tanstack/react-router"
import { apiSession, errorResponse } from "../server/api.ts"
import { fetchSimilar } from "../server/jobs.ts"

/** GET `?posting=at://…`: similar candidates, for the posting's author only (403 otherwise). */
export const Route = createFileRoute("/api/jobs/similar")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await apiSession(request)
        if ("response" in session) return session.response
        const posting = new URL(request.url).searchParams.get("posting")
        if (!posting?.startsWith("at://")) {
          return Response.json({ error: "InvalidRequest" }, { status: 400 })
        }
        try {
          return Response.json(await fetchSimilar(session.agent, posting))
        } catch (err) {
          return errorResponse(err)
        }
      },
    },
  },
})
