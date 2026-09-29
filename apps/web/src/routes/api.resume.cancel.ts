import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { apiSession, errorResponse } from "../server/api.ts"
import { discardDraft } from "../server/resume.ts"

/** POST `{ id }` to discard a draft without writing anything. */
export const Route = createFileRoute("/api/resume/cancel")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const session = await apiSession(request)
        if ("response" in session) return session.response
        try {
          const { id } = z
            .object({ id: z.string().min(1).max(64) })
            .parse(await request.json())
          return Response.json({
            deleted: await discardDraft(session.agent, id),
          })
        } catch (err) {
          return errorResponse(err)
        }
      },
    },
  },
})
