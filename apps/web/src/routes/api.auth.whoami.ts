import { createFileRoute } from "@tanstack/react-router"
import { getSessionAgent } from "../server/session.ts"

/**
 * Who the current session belongs to, answered by making a real authenticated
 * call to the user's PDS — so it proves the stored OAuth tokens still work.
 */
export const Route = createFileRoute("/api/auth/whoami")({
  server: {
    handlers: {
      GET: async () => {
        const agent = await getSessionAgent()
        if (!agent) return Response.json({ signedIn: false }, { status: 401 })
        const { data } = await agent.com.atproto.server.getSession()
        return Response.json({
          signedIn: true,
          did: data.did,
          handle: data.handle,
        })
      },
    },
  },
})
