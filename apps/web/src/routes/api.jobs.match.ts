import { createFileRoute } from "@tanstack/react-router"
import { apiSession, errorResponse } from "../server/api.ts"
import { fetchMatch } from "../server/jobs.ts"

/**
 * GET `?posting=at://…`: the signed-in person's own match with a posting,
 * as a coarse label. There is no way to ask about anyone else: the AppView
 * answers for the service-auth issuer only.
 */
export const Route = createFileRoute("/api/jobs/match")({
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
          return Response.json(await fetchMatch(session.agent, posting))
        } catch (err) {
          return errorResponse(err)
        }
      },
    },
  },
})
