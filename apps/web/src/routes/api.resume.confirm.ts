import { createFileRoute } from "@tanstack/react-router"
import { apiSession, errorResponse } from "../server/api.ts"
import { confirmResume } from "../server/resume.ts"

/** POST the accepted entries (`ConfirmInput`) to write them to the repo. */
export const Route = createFileRoute("/api/resume/confirm")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const session = await apiSession(request)
        if ("response" in session) return session.response
        try {
          const body: unknown = await request.json()
          return Response.json(await confirmResume(session.agent, body))
        } catch (err) {
          return errorResponse(err)
        }
      },
    },
  },
})
