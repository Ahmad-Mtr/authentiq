import { createFileRoute, notFound } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { FeedEntries } from "../components/feeds/feed-entries.tsx"
import { PinButton } from "../components/feeds/pin-button.tsx"
import { feedUriOf } from "../lib/feed-types.ts"
import { getFeedPage } from "../server/feeds-fns.ts"

export const Route = createFileRoute("/feeds/$actor/$rkey")({
  loader: async ({ params }) => {
    const data = await getFeedPage({
      data: { uri: feedUriOf(params.actor, params.rkey) },
    })
    if (!data) throw notFound()
    return data
  },
  component: FeedPage,
})

/** One feed: who publishes it, which service builds it, and its items. */
function FeedPage() {
  const { generator: g, page, viewer } = Route.useLoaderData()
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{g.displayName}</h1>
          {viewer ? <PinButton feed={g.uri} pinned={g.pinned} /> : null}
        </div>
        {g.description ? (
          <p className="text-sm text-muted-foreground" dir="auto">
            {g.description}
          </p>
        ) : null}
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Published by @{g.creator.handle} · built by
          <Badge variant="outline" className="font-mono text-[10px]">
            {decodeURIComponent(g.did)}
          </Badge>
        </p>
      </header>
      <div className="mt-8">
        <FeedEntries
          page={page}
          source={{ kind: "feed", uri: g.uri }}
          viewer={viewer}
          empty="Nothing in this feed right now."
        />
      </div>
    </main>
  )
}
