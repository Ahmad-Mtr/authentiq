import type { Agent } from "@atproto/api"
import { env } from "./env.ts"

/**
 * Calls from the BFF to the AppView on the signed-in user's behalf (phase 4
 * resume import, phase 5 recruiting agent). Each call carries an ATProto
 * service auth token that the user's PDS mints for exactly one method
 * (`lxm`), for 60 seconds; the AppView verifies it against the user's DID
 * document. Server-only: never import this from a route component.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
    readonly issues?: Array<{ path: string; message: string }>
  ) {
    super(message)
  }
}

export async function callAppView(
  agent: Agent,
  lxm: string,
  init: RequestInit & { query?: Record<string, string> } = {}
) {
  const { data } = await agent.com.atproto.server.getServiceAuth({
    aud: env.APPVIEW_DID,
    lxm,
    exp: Math.floor(Date.now() / 1000) + 60,
  })
  const url = new URL(`/xrpc/${lxm}`, env.APPVIEW_URL)
  for (const [k, v] of Object.entries(init.query ?? {})) {
    url.searchParams.set(k, v)
  }
  return fetch(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${data.token}` },
  })
}

/** An AppView XRPC error response as an ApiError. */
export async function appViewError(res: Response) {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string
    message?: string
  }
  return new ApiError(
    res.status,
    body.error ?? "AppViewError",
    body.message ?? `AppView returned ${res.status}`
  )
}
