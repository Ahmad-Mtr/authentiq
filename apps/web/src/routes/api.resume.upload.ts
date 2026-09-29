import { createFileRoute } from "@tanstack/react-router"
import { apiSession, errorResponse, readCapped } from "../server/api.ts"
import { MAX_RESUME_BYTES, uploadResume } from "../server/resume.ts"

/**
 * POST the resume file as the raw body, with its content type. Relayed to the
 * AppView, which checks the bytes and parses it. Returns the draft to review.
 */
export const Route = createFileRoute("/api/resume/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const session = await apiSession(request)
        if ("response" in session) return session.response
        const bytes = await readCapped(request, MAX_RESUME_BYTES)
        if (!bytes) {
          return Response.json(
            { error: "FileTooLarge", message: "Resumes are limited to 5 MB" },
            { status: 413 }
          )
        }
        try {
          const draft = await uploadResume(
            session.agent,
            bytes,
            request.headers.get("content-type") ?? "application/octet-stream"
          )
          return Response.json(draft)
        } catch (err) {
          return errorResponse(err)
        }
      },
    },
  },
})
