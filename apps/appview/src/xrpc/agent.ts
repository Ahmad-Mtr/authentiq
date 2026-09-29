import { Elysia, status, t } from "elysia"
import { sh } from "@workspace/lexicons"
import { MAX_TURNS, openConversation } from "../agent/conversations.ts"
import { runTurn } from "../agent/loop.ts"
import { verifyServiceAuth } from "../auth.ts"
import { createRateLimiter } from "../ratelimit.ts"

/**
 * sh.authentiq.agent.chat: one agent turn, streamed as server-sent events.
 *
 * The loop runs here, next to the search code its tools call, not in the web
 * BFF. The BFF authenticates the user the phase 4 way: a service auth token
 * from their PDS for exactly this method. XRPC queries do not stream, so the
 * response is `text/event-stream`; errors before the stream starts are plain
 * XRPC JSON errors.
 */

const LXM = sh.authentiq.agent.chat.$lxm
const turns = createRateLimiter(20, 60 * 60 * 1000)

export const agentRoute = new Elysia().post(
  `/xrpc/${LXM}`,
  async ({ headers, body, request }) => {
    const auth = await verifyServiceAuth(headers.authorization, LXM)
    if (!("did" in auth)) return status(401, auth)
    if (!turns.allow(auth.did)) {
      return status(429, {
        error: "RateLimitExceeded",
        message: `At most ${turns.limit} agent turns per hour`,
      })
    }
    const conversation = openConversation(auth.did, body.conversationId)
    if (!conversation) {
      return status(400, {
        error: "ConversationNotFound",
        message: "This conversation has expired. Start a new one.",
      })
    }
    if (conversation.turns.length >= MAX_TURNS) {
      return status(400, {
        error: "ConversationNotFound",
        message: `Conversations are limited to ${MAX_TURNS} turns. Start a new one.`,
      })
    }

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: string, data: unknown) =>
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          )
        try {
          await runTurn(conversation, body.message, emit, request.signal)
        } catch (err) {
          // The type only: provider errors can echo the conversation.
          console.error(
            `[agent] ${auth.did} turn failed: ${(err as Error).name}`
          )
          emit("error", {
            message: "The assistant is unavailable. Try again shortly.",
          })
        } finally {
          controller.close()
        }
      },
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    })
  },
  {
    body: t.Object({
      conversationId: t.Optional(t.String({ maxLength: 64 })),
      message: t.String({ minLength: 1, maxLength: 2000 }),
    }),
  }
)
