import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { useState } from "react"
import type { FeedEntryUI, FeedPageUI } from "../../lib/feed-types.ts"
import { JobCard } from "../jobs/job-card.tsx"
import { PostCard } from "../social/post-card.tsx"

/**
 * A hydrated feed (phase 8): posts and job postings in the generator's
 * order, then "Load more" while there is a cursor. The next page comes from
 * the same API route verify:feeds uses. A feed that fails says so and
 * nothing else on the page is affected.
 */
export function FeedEntries({
  page,
  source,
  viewer,
  empty,
}: {
  page: FeedPageUI
  /** Where "Load more" reads the next page from. */
  source: { kind: "timeline" } | { kind: "feed"; uri: string }
  viewer: string | null
  empty: string
}) {
  const [entries, setEntries] = useState(page.ok ? page.entries : [])
  const [cursor, setCursor] = useState(page.ok ? page.cursor : undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!page.ok) return <FeedProblem error={page.error} message={page.message} />

  const loadMore = async () => {
    if (!cursor) return
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ cursor })
    if (source.kind === "feed") params.set("feed", source.uri)
    const path =
      source.kind === "feed" ? "/api/feeds/feed" : "/api/feeds/timeline"
    try {
      const res = await fetch(`${path}?${params}`)
      const next = (await res.json()) as FeedPageUI
      if (!next.ok) throw new Error(next.message)
      // A generator may repeat itself across pages; show each item once.
      const seen = new Set(entries.map(keyOf))
      setEntries([...entries, ...next.entries.filter((e) => !seen.has(keyOf(e)))])
      setCursor(next.cursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid gap-3" data-testid="feed">
      {entries.map((entry) =>
        entry.kind === "post" ? (
          <PostCard
            key={keyOf(entry)}
            post={entry.post}
            replyTo={entry.replyTo}
            viewer={viewer}
          />
        ) : (
          <JobCard key={keyOf(entry)} job={entry.job} />
        )
      )}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {cursor ? (
        <Button
          variant="outline"
          onClick={loadMore}
          disabled={loading}
          className="justify-self-center"
        >
          {loading ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  )
}

const keyOf = (e: FeedEntryUI) => (e.kind === "post" ? e.post.uri : e.job.uri)

export function FeedProblem({ error, message }: { error: string; message: string }) {
  if (error === "AuthRequired") {
    return (
      <Alert data-testid="feed-problem">
        <AlertTitle>Sign in to see this feed</AlertTitle>
        <AlertDescription>
          It is built for the person reading it, so it needs to know who you are.
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert variant="destructive" data-testid="feed-problem">
      <AlertTitle>This feed is unavailable</AlertTitle>
      <AlertDescription>
        {message}. Other feeds and your timeline are not affected.
      </AlertDescription>
    </Alert>
  )
}
