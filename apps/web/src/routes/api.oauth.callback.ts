import { createFileRoute } from "@tanstack/react-router"
import { oauthClient } from "../server/oauth.ts"
import { createWebSession } from "../server/session.ts"

/** Where the PDS sends the user back after they approve (or refuse). */
export const Route = createFileRoute("/api/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams
        try {
          const { session } = await oauthClient.callback(params)
          await createWebSession(session.did)
          return new Response(null, {
            status: 303,
            headers: { location: "/profile/edit" },
          })
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Sign-in failed"
          return new Response(null, {
            status: 303,
            headers: { location: `/login?error=${encodeURIComponent(message)}` },
          })
        }
      },
    },
  },
})
