import { Link, createFileRoute } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { PinButton } from "../components/feeds/pin-button.tsx"
import { feedParams } from "../lib/feed-types.ts"
import { getFeedDirectory } from "../server/feeds-fns.ts"

export const Route = createFileRoute("/feeds/")({
  loader: () => getFeedDirectory(),
  component: Directory,
})

/**
 * Feed discovery: every feed the AppView has indexed, from any publisher,
 * oldest first. There is no "popular" order, because nothing is counted.
 * Anyone can publish a feed; the badge says who runs the service behind it.
 */
function Directory() {
  const { feeds, viewer } = Route.useLoaderData()
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold">Feeds</h1>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        A feed is a record anyone can publish, pointing at a service that picks
        posts or jobs. Authentiq fetches the list, then shows it under its own
        rules: hidden, deleted and closed items never appear, whoever built the
        feed. Pin the ones you want on your home page.
      </p>
      <ul className="mt-8 grid gap-3">
        {feeds.map((g) => (
          <li key={g.uri} className="rounded-lg border p-4" data-feed-uri={g.uri}>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/feeds/$actor/$rkey"
                params={feedParams(g.uri)}
                className="font-medium hover:underline"
              >
                {g.displayName}
              </Link>
              <span className="text-xs text-muted-foreground">
                by @{g.creator.handle}
              </span>
              <Badge variant="outline" className="font-mono text-[10px]">
                {decodeURIComponent(g.did)}
              </Badge>
              {viewer ? (
                <span className="ml-auto">
                  <PinButton feed={g.uri} pinned={g.pinned} />
                </span>
              ) : null}
            </div>
            {g.description ? (
              <p className="mt-2 text-sm text-muted-foreground" dir="auto">
                {g.description}
              </p>
            ) : null}
          </li>
        ))}
        {feeds.length === 0 ? (
          <li className="text-sm text-muted-foreground">No feeds yet.</li>
        ) : null}
      </ul>
    </main>
  )
}
