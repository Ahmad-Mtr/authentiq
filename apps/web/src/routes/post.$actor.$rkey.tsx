import {
  Link,
  createFileRoute,
  notFound,
  useRouter,
} from "@tanstack/react-router"
import { ThreadView } from "../components/social/thread-view.tsx"
import { getThread } from "../server/social-fns.ts"

export const Route = createFileRoute("/post/$actor/$rkey")({
  loader: async ({ params }) => {
    const data = await getThread({
      data: {
        uri: `at://${params.actor}/sh.authentiq.feed.post/${params.rkey}`,
      },
    })
    if (!data.thread) throw notFound()
    return data
  },
  component: PostPage,
})

function PostPage() {
  const { thread, viewer } = Route.useLoaderData()
  const router = useRouter()
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <p className="mb-4 text-xs text-muted-foreground">
        <Link to="/" className="hover:underline">
          Home
        </Link>{" "}
        · Thread
      </p>
      <ThreadView
        thread={thread!}
        viewer={viewer}
        onDeleted={async () => {
          await router.navigate({
            to: "/p/$actor",
            params: { actor: viewer ?? "" },
          })
        }}
      />
    </main>
  )
}
