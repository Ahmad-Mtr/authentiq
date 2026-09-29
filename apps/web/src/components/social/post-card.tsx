import { Link, useRouter } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { useState } from "react"
import type { ReactNode } from "react"
import { postJson, postParams, repoOf } from "../../lib/actions.ts"
import type { FeedItemUI, PostUI } from "../../lib/social-types.ts"
import { RichText, formatDate } from "./rich-text.tsx"

/**
 * One post. Actions depend on who is looking: like (anyone signed in),
 * delete (the author), hide (the creator of the community the post is shown
 * in). There is no like count, by design: the button only says whether
 * *you* liked it. The reply count is thread navigation.
 */
export function PostCard({
  post,
  viewer,
  replyTo,
  onReply,
  onDeleted,
  showThreadLink = true,
  className,
}: {
  post: PostUI
  viewer: string | null
  replyTo?: FeedItemUI["replyTo"]
  onReply?: () => void
  onDeleted?: () => void | Promise<void>
  showThreadLink?: boolean
  className?: string
}) {
  const router = useRouter()
  const [like, setLike] = useState(post.like)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const params = postParams(post.uri)
  const moderates =
    viewer !== null && post.community && repoOf(post.community.uri) === viewer

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setBusy(null)
    }
  }

  const toggleLike = () =>
    act("like", async () => {
      if (like) {
        await postJson("/api/records/delete", { uri: like })
        setLike(undefined)
      } else {
        const res = await postJson<{ uri: string }>("/api/likes", {
          subject: post.uri,
        })
        setLike(res.uri)
      }
    })

  return (
    <article
      className={cn("grid gap-2 rounded-lg border p-4", className)}
      data-post-uri={post.uri}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <Link
          to="/p/$actor"
          params={{ actor: post.author.did }}
          className="font-medium hover:underline"
        >
          {post.author.displayName ?? post.author.handle}
        </Link>
        <span className="text-xs text-muted-foreground">
          @{post.author.handle}
        </span>
        <Link
          to="/post/$actor/$rkey"
          params={params}
          className="text-xs text-muted-foreground hover:underline"
        >
          {formatDate(post.createdAt)}
        </Link>
        {post.community ? (
          <Badge
            variant="secondary"
            className="ml-auto"
            render={
              <Link
                to="/c/$actor/$rkey"
                params={postParams(post.community.uri)}
              />
            }
          >
            {post.community.name}
          </Badge>
        ) : null}
      </header>

      {replyTo ? <ReplyContext replyTo={replyTo} /> : null}

      <RichText text={post.text} facets={post.facets} />

      {post.link ? (
        <a
          href={post.link.uri}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          className="block rounded-md border px-3 py-2 hover:bg-muted/50"
        >
          <span className="block text-sm font-medium" dir="auto">
            {post.link.title}
          </span>
          {post.link.description ? (
            <span className="block text-xs text-muted-foreground" dir="auto">
              {post.link.description}
            </span>
          ) : null}
          <span className="block truncate text-xs text-muted-foreground">
            {post.link.uri}
          </span>
        </a>
      ) : null}

      <footer className="flex flex-wrap items-center gap-1">
        {showThreadLink ? (
          <Link
            to="/post/$actor/$rkey"
            params={params}
            className={buttonVariants({ variant: "ghost", size: "xs" })}
          >
            {replyLabel(post.replyCount)}
          </Link>
        ) : null}
        {onReply && viewer ? (
          <Button variant="ghost" size="xs" onClick={onReply}>
            Reply
          </Button>
        ) : null}
        {viewer ? (
          <Button
            variant={like ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={Boolean(like)}
            disabled={busy === "like"}
            onClick={() => void toggleLike()}
          >
            {like ? "Liked" : "Like"}
          </Button>
        ) : null}
        {moderates ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy === "hide"}
            onClick={() =>
              void act("hide", async () => {
                await postJson("/api/communities/hide", {
                  community: post.community!.uri,
                  post: post.uri,
                  hidden: true,
                })
                await router.invalidate()
              })
            }
          >
            Hide from community
          </Button>
        ) : null}
        {viewer === post.author.did ? (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-destructive"
            disabled={busy === "delete"}
            onClick={() => {
              if (!window.confirm("Delete this post from your repo?")) return
              void act("delete", async () => {
                await postJson("/api/records/delete", { uri: post.uri })
                await (onDeleted ? onDeleted() : router.invalidate())
              })
            }}
          >
            Delete
          </Button>
        ) : null}
      </footer>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </article>
  )
}

const replyLabel = (n: number) =>
  n === 0 ? "Open thread" : n === 1 ? "1 reply" : `${n} replies`

function ReplyContext({
  replyTo,
}: {
  replyTo: NonNullable<FeedItemUI["replyTo"]>
}) {
  let label: ReactNode
  if (replyTo.kind === "post") {
    label = (
      <>
        Replying to{" "}
        <Link
          to="/post/$actor/$rkey"
          params={postParams(replyTo.post.uri)}
          className="hover:underline"
        >
          @{replyTo.post.author.handle}
        </Link>
      </>
    )
  } else {
    label =
      replyTo.kind === "hidden"
        ? "Replying to a hidden post"
        : "Replying to a post that is not available"
  }
  return <p className="text-xs text-muted-foreground">{label}</p>
}
