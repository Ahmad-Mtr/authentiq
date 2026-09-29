import { createFileRoute } from "@tanstack/react-router"
import { errorResponse } from "../server/api.ts"
import { fetchFeed } from "../server/feeds.ts"
import { getSessionAgent } from "../server/session.ts"

/**
 * GET `?feed=at://…&cursor=…`: one page of a feed, hydrated, as the pages
 * render it. Signed in, the user's PDS signs the viewer token for the feed's
 * generator; signed out, the request is anonymous. The AppView's error
 * (FeedUnavailable, AuthRequired, UnknownFeed) comes back with its status.
 */
export const Route = createFileRoute("/api/feeds/feed")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams
        const feed = params.get("feed")
        if (!feed?.startsWith("at://")) {
          return Response.json({ error: "InvalidRequest" }, { status: 400 })
        }
        try {
          const page = await fetchFeed(await getSessionAgent(), {
            feed,
            cursor: params.get("cursor") ?? undefined,
            limit: Number(params.get("limit") ?? 20) || 20,
          })
          const status = page.ok
            ? 200
            : page.error === "AuthRequired"
              ? 401
              : page.error === "FeedUnavailable"
                ? 502
                : 400
          return Response.json(page, { status })
        } catch (err) {
          return errorResponse(err)
        }
      },
    },
  },
})
