import { createFileRoute } from "@tanstack/react-router"
import { env } from "../server/env.ts"
import { oauthClient } from "../server/oauth.ts"

/**
 * Dev-only convenience: create an account on our local PDS, then hand straight
 * over to the normal OAuth flow. A real deployment would let users bring an
 * account from any PDS instead.
 */
export const Route = createFileRoute("/api/auth/signup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData()
        const handle = String(form.get("handle") ?? "").trim()
        const email = String(form.get("email") ?? "").trim()
        const password = String(form.get("password") ?? "")

        const res = await fetch(
          new URL("/xrpc/com.atproto.server.createAccount", env.PDS_URL),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ handle, email, password }),
          }
        )
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            message?: string
          }
          return fail(body.message ?? `Could not create account (${res.status})`)
        }

        try {
          const url = await oauthClient.authorize(handle)
          return Response.redirect(url, 303)
        } catch (err) {
          return fail(
            err instanceof Error ? err.message : "Account created, sign-in failed"
          )
        }
      },
    },
  },
})

function fail(error: string) {
  return new Response(null, {
    status: 303,
    headers: { location: `/login?error=${encodeURIComponent(error)}&mode=signup` },
  })
}
