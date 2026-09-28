import { createFileRoute } from "@tanstack/react-router"
import { oauthClient } from "../server/oauth.ts"

/**
 * Starts the OAuth flow: resolve the handle to its PDS, push an authorization
 * request (PAR), and redirect the browser to that server's consent screen.
 */
export const Route = createFileRoute("/api/oauth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData()
        const handle = String(form.get("handle") ?? "").trim()
        if (!handle) {
          return redirectToLogin("Enter your handle")
        }
        try {
          const url = await oauthClient.authorize(handle)
          return Response.redirect(url, 303)
        } catch (err) {
          return redirectToLogin(
            err instanceof Error ? err.message : "Could not start sign-in"
          )
        }
      },
    },
  },
})

function redirectToLogin(error: string) {
  return new Response(null, {
    status: 303,
    headers: { location: `/login?error=${encodeURIComponent(error)}` },
  })
}
