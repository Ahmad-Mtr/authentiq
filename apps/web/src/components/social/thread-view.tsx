import { useRouter } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { useState } from "react"
import { postJson, repoOf } from "../../lib/actions.ts"
import type { ThreadUI } from "../../lib/social-types.ts"
import { Composer } from "./composer.tsx"
import { PostCard } from "./post-card.tsx"

type Ctx = {
  viewer: string | null
  /** The community the thread is shown in, if any. */
  community?: string
  onChanged: () => Promise<void>
}

/**
 * A thread from sh.authentiq.feed.getPostThread: parents above the post,
 * replies nested below. Placeholders keep their replies, so deleting or
 * hiding a post in the middle does not cut the conversation.
 */
export function ThreadView({
  thread,
  viewer,
  onDeleted,
}: {
  thread: ThreadUI
  viewer: string | null
  onDeleted: () => Promise<void>
}) {
  const router = useRouter()
  const parents: Array<ThreadUI> = []
  for (
    let p = thread.kind === "post" ? thread.parent : undefined;
    p;
    p = p.kind === "post" ? p.parent : undefined
  ) {
    parents.unshift(p)
  }
  const ctx: Ctx = {
    viewer,
    community: thread.kind === "post" ? thread.post.community?.uri : undefined,
    onChanged: () => router.invalidate(),
  }

  return (
    <div className="grid gap-3">
      {parents.map((p) =>
        p.kind === "post" ? (
          <PostCard
            key={p.post.uri}
            post={p.post}
            viewer={viewer}
            className="opacity-80"
          />
        ) : (
          <Placeholder key={p.uri} node={p} ctx={ctx} />
        )
      )}
      <Node node={thread} ctx={ctx} anchor onDeleted={onDeleted} />
    </div>
  )
}

function Node({
  node,
  ctx,
  anchor,
  onDeleted,
}: {
  node: ThreadUI
  ctx: Ctx
  anchor?: boolean
  onDeleted?: () => Promise<void>
}) {
  const [replying, setReplying] = useState(false)
  return (
    <div className="grid gap-3">
      {node.kind === "post" ? (
        <>
          <PostCard
            post={node.post}
            viewer={ctx.viewer}
            showThreadLink={!anchor}
            className={anchor ? "border-primary/40" : undefined}
            onReply={() => setReplying(!replying)}
            onDeleted={anchor ? onDeleted : ctx.onChanged}
          />
          {replying || (anchor && ctx.viewer) ? (
            <div className="ml-4 border-l pl-4">
              <Composer
                replyTo={node.post.uri}
                placeholder={`Reply to @${node.post.author.handle}…`}
                submitLabel="Reply"
                autoFocus={replying}
                onPosted={async () => {
                  setReplying(false)
                  await ctx.onChanged()
                }}
              />
            </div>
          ) : null}
        </>
      ) : (
        <Placeholder node={node} ctx={ctx} />
      )}
      {node.replies.length > 0 ? (
        <div className="ml-4 grid gap-3 border-l pl-4">
          {node.replies.map((r) => (
            <Node
              key={r.kind === "post" ? r.post.uri : r.uri}
              node={r}
              ctx={ctx}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Placeholder({
  node,
  ctx,
}: {
  node: Exclude<ThreadUI, { kind: "post" }>
  ctx: Ctx
}) {
  const [busy, setBusy] = useState(false)
  const community =
    node.kind === "hidden" ? (node.community ?? ctx.community) : undefined
  const canUnhide =
    community !== undefined &&
    ctx.viewer !== null &&
    repoOf(community) === ctx.viewer
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      data-placeholder={node.kind}
      data-post-uri={node.uri}
    >
      {node.kind === "hidden"
        ? "Hidden by the community's creator."
        : "This post was deleted or is not available."}
      {canUnhide ? (
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void postJson("/api/communities/hide", {
              community,
              post: node.uri,
              hidden: false,
            })
              .then(ctx.onChanged)
              .finally(() => setBusy(false))
          }}
        >
          Unhide
        </Button>
      ) : null}
    </div>
  )
}
