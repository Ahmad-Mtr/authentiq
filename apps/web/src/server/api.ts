import type { Agent } from "@atproto/api"
import { env } from "./env.ts"
import { ApiError } from "./appview.ts"
import { getSessionAgent } from "./session.ts"

/**
 * Helpers for JSON API routes that act for the signed-in user. The session
 * cookie is `SameSite=Lax`, so cross-site POSTs arrive without it. The
 * Origin check is a second line: browsers always send Origin on a POST.
 */
export async function apiSession(request: Request) {
  const origin = request.headers.get("origin")
  if (origin && origin !== env.WEB_ORIGIN) {
    return { response: Response.json({ error: "BadOrigin" }, { status: 403 }) }
  }
  const agent = await getSessionAgent()
  if (!agent) {
    return {
      response: Response.json(
        { error: "AuthRequired", message: "Sign in first" },
        { status: 401 }
      ),
    }
  }
  return { agent }
}

export function errorResponse(err: unknown) {
  if (err instanceof ApiError) {
    return Response.json(
      { error: err.error, message: err.message, issues: err.issues },
      { status: err.status }
    )
  }
  // Never echo or log request content: it may be a resume or a conversation.
  console.error("[api] request failed:", (err as Error).name)
  return Response.json(
    { error: "InternalError", message: "Something went wrong" },
    { status: 500 }
  )
}

/** Reads a request body, aborting once it passes `max` bytes. */
export async function readCapped(request: Request, max: number) {
  if (Number(request.headers.get("content-length") ?? 0) > max) return null
  if (!request.body) return new Uint8Array()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for await (const chunk of request.body) {
    size += chunk.byteLength
    if (size > max) {
      await request.body.cancel().catch(() => {})
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * A JSON POST API route that acts for the signed-in user: session and Origin
 * check, a capped body, then `fn`. Used by the phase 6 write routes, which
 * `bun run verify:social` calls the way the browser does.
 */
export function jsonAction(
  fn: (agent: Agent, body: unknown) => Promise<unknown>,
  maxBytes = 128 * 1024
) {
  return async ({ request }: { request: Request }) => {
    const session = await apiSession(request)
    if ("response" in session) return session.response
    try {
      const raw = await readCapped(request, maxBytes)
      if (!raw) {
        return Response.json(
          { error: "PayloadTooLarge", message: "Request body is too large" },
          { status: 413 }
        )
      }
      let body: unknown
      try {
        body = JSON.parse(new TextDecoder().decode(raw))
      } catch {
        return Response.json(
          { error: "InvalidRequest", message: "Send a JSON body" },
          { status: 400 }
        )
      }
      return Response.json(await fn(session.agent, body))
    } catch (err) {
      return errorResponse(err)
    }
  }
}
