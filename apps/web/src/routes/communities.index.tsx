import { Link, createFileRoute } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { buttonVariants } from "@workspace/ui/components/button"
import { communityParams } from "../lib/actions.ts"
import { getCommunities } from "../server/social-fns.ts"

export const Route = createFileRoute("/communities/")({
  loader: () => getCommunities(),
  component: Communities,
})

function Communities() {
  const { communities, viewer } = Route.useLoaderData()
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Communities</h1>
        {viewer ? (
          <Link
            to="/communities/new"
            className={buttonVariants({ size: "sm", className: "ml-auto" })}
          >
            Create a community
          </Link>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Each community is about one topic. Members start threads; anyone can
        reply.
      </p>
      <ul className="mt-6 grid gap-3">
        {communities.map((c) => (
          <li key={c.uri} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/c/$actor/$rkey"
                params={communityParams(c.uri)}
                className="font-medium hover:underline"
              >
                {c.name}
              </Link>
              <Badge variant="outline">{c.topic}</Badge>
              {c.isCreator ? (
                <Badge variant="secondary">You created this</Badge>
              ) : c.membership ? (
                <Badge variant="secondary">Joined</Badge>
              ) : null}
            </div>
            {c.description ? (
              <p className="mt-1 text-sm text-muted-foreground" dir="auto">
                {c.description}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">
              by @{c.creator.handle}
            </p>
          </li>
        ))}
        {communities.length === 0 ? (
          <li className="text-sm text-muted-foreground">No communities yet.</li>
        ) : null}
      </ul>
    </main>
  )
}
