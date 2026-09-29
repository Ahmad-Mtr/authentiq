import {
  Link,
  createFileRoute,
  notFound,
  useRouter,
} from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Separator } from "@workspace/ui/components/separator"
import { useState } from "react"
import { Composer } from "../components/social/composer.tsx"
import { PostCard } from "../components/social/post-card.tsx"
import { postJson } from "../lib/actions.ts"
import { getCommunityPage } from "../server/social-fns.ts"

export const Route = createFileRoute("/c/$actor/$rkey")({
  loader: async ({ params }) => {
    const data = await getCommunityPage({
      data: {
        uri: `at://${params.actor}/sh.authentiq.community.declaration/${params.rkey}`,
      },
    })
    if (!data) throw notFound()
    return data
  },
  component: CommunityPage,
})

function CommunityPage() {
  const { community, feed, viewer } = Route.useLoaderData()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canPost = community.isCreator || Boolean(community.membership)

  const toggleMembership = async () => {
    setBusy(true)
    setError(null)
    try {
      if (community.membership) {
        await postJson("/api/records/delete", { uri: community.membership })
      } else {
        await postJson("/api/communities/join", { community: community.uri })
      }
      // The BFF answers once the AppView has indexed the change.
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <p className="mb-4 text-xs text-muted-foreground">
        <Link to="/communities" className="hover:underline">
          Communities
        </Link>
      </p>
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold" dir="auto">
            {community.name}
          </h1>
          <Badge variant="outline">{community.topic}</Badge>
          {viewer && !community.isCreator ? (
            <Button
              size="sm"
              className="ml-auto"
              variant={community.membership ? "secondary" : "default"}
              disabled={busy}
              onClick={() => void toggleMembership()}
            >
              {community.membership ? "Leave" : "Join"}
            </Button>
          ) : null}
          {community.isCreator ? (
            <Badge variant="secondary" className="ml-auto">
              You created this community
            </Badge>
          ) : null}
        </div>
        {community.description ? (
          <p className="text-sm leading-relaxed" dir="auto">
            {community.description}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Created by{" "}
          <Link
            to="/p/$actor"
            params={{ actor: community.creator.did }}
            className="hover:underline"
          >
            @{community.creator.handle}
          </Link>
        </p>
        {community.rules.length > 0 ? (
          <ol
            dir="auto"
            className="mt-2 list-decimal ps-5 text-sm text-muted-foreground"
          >
            {community.rules.map((r, i) => (
              <li key={i} dir="auto">
                {r}
              </li>
            ))}
          </ol>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </header>

      <Separator className="my-8" />

      {viewer && canPost ? (
        <Composer
          community={community.uri}
          placeholder={`Start a thread in ${community.name}…`}
          onPosted={() => router.invalidate()}
        />
      ) : viewer ? (
        <p className="text-sm text-muted-foreground">
          Join to start threads here. Anyone can reply to them.
        </p>
      ) : null}

      <div className="mt-6 grid gap-3">
        {feed.map((item) => (
          <PostCard key={item.post.uri} post={item.post} viewer={viewer} />
        ))}
        {feed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No threads yet.</p>
        ) : null}
      </div>
    </main>
  )
}
