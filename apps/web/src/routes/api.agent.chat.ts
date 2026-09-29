import { createFileRoute } from "@tanstack/react-router"
import { sh } from "@workspace/lexicons"
import { z } from "zod"
import { apiSession, errorResponse, readCapped } from "../server/api.ts"
import { appViewError, callAppView } from "../server/appview.ts"

const input = z.object({
  conversationId: z.string().max(64).optional(),
  message: z.string().trim().min(1).max(2000),
})

/**
 * POST `{ message, conversationId? }`: one turn of the recruiting agent. The
 * loop runs in the AppView; this route authenticates the session, gets a
 * service auth token for `sh.authentiq.agent.chat`, and pipes the AppView's
 * server-sent events through unchanged.
 */
export const Route = createFileRoute("/api/agent/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const session = await apiSession(request)
        if ("response" in session) return session.response
        try {
          const raw = await readCapped(request, 16 * 1024)
          let json: unknown = null
          try {
            json = raw ? JSON.parse(new TextDecoder().decode(raw)) : null
          } catch {
            // Falls through to the 400 below.
          }
          const parsed = input.safeParse(json)
          if (!parsed.success) {
            return Response.json(
              {
                error: "InvalidRequest",
                message: "Send { message } of 1-2000 characters",
              },
              { status: 400 }
            )
          }
          const upstream = await callAppView(
            session.agent,
            sh.authentiq.agent.chat.$lxm,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(parsed.data),
              signal: request.signal,
            }
          )
          if (!upstream.ok || !upstream.body) throw await appViewError(upstream)
          return new Response(upstream.body, {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
            },
          })
        } catch (err) {
          return errorResponse(err)
        }
      },
    },
  },
})
