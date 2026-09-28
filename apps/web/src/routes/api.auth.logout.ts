import { createFileRoute } from "@tanstack/react-router"
import { destroyWebSession } from "../server/session.ts"

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async () => {
        await destroyWebSession()
        return new Response(null, { status: 303, headers: { location: "/" } })
      },
    },
  },
})
