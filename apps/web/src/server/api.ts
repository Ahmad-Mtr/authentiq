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
