import { Link, createFileRoute, useRouter } from "@tanstack/react-router"
import { z } from "zod"
import { FeedEntries } from "../components/feeds/feed-entries.tsx"
import { FeedSwitcher } from "../components/feeds/feed-switcher.tsx"
import { Composer } from "../components/social/composer.tsx"
import { feedParams } from "../lib/feed-types.ts"
import { postParams } from "../lib/actions.ts"
import { getHome } from "../server/feeds-fns.ts"

const search = z.object({
  feed: z
    .string()
    .regex(/^at:\/\/[^/]+\/sh\.authentiq\.feed\.generator\/[^/]+$/)
    .optional()
    .catch(undefined),
})

export const Route = createFileRoute("/")({
  validateSearch: search,
  loaderDeps: ({ search: s }) => ({ feed: s.feed }),
  loader: ({ deps }) => getHome({ data: { feed: deps.feed } }),
  component: Home,
})

function Home() {
  const home = Route.useLoaderData()
  return home ? <SignedInHome home={home} /> : <Landing />
}

type HomeData = NonNullable<ReturnType<typeof Route.useLoaderData>>

/**
 * Signed in: the composer, then a feed. "Home" is the timeline (posts by the
 * people you follow, newest first, served by the AppView); the other tabs are
 * the feeds you pinned, each built by its own generator. Nothing is chosen
 * for you: a feed you did not pick would be ranking by another name.
 */
function SignedInHome({ home }: { home: HomeData }) {
  const router = useRouter()
  const { viewer, pinned, selected, page } = home
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold">Write something worth reading</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Up to 3000 characters. Mention people with @handle. Posts are records in
        your repo; there are no reshares and no like counts.
      </p>
      <div className="mt-6">
        <Composer
          onPosted={(uri) =>
            router.navigate({
              to: "/post/$actor/$rkey",
              params: postParams(uri),
            })
          }
        />
      </div>

      <section className="mt-10 grid gap-4">
        <FeedSwitcher pinned={pinned} selected={selected?.uri ?? null} />
        {selected ? (
          <p className="text-sm text-muted-foreground">
            {selected.description}{" "}
            <Link
              to="/feeds/$actor/$rkey"
              params={feedParams(selected.uri)}
              className="underline"
            >
              About this feed
            </Link>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Posts from the people you follow, newest first.
          </p>
        )}
        <FeedEntries
          // Remount per feed, so "Load more" state does not carry over.
          key={selected?.uri ?? "timeline"}
          page={page}
          source={
            selected ? { kind: "feed", uri: selected.uri } : { kind: "timeline" }
          }
          viewer={viewer}
          empty={
            selected
              ? "Nothing in this feed for you yet."
              : "Nothing yet. Follow people from their profiles, or pin a feed."
          }
        />
      </section>
    </main>
  )
}

function Landing() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold">
        A professional network you can take with you
      </h1>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
        Authentiq is built on the AT Protocol. Your profile, roles and posts are
        records in a repository you own, hosted on your own PDS. Authentiq only
        indexes them — leave, and your data goes with you.
      </p>
      <div className="mt-8 flex gap-3 text-sm">
        <Link
          to="/login"
          className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
        >
          Sign in with your handle
        </Link>
        <Link to="/communities" className="rounded-md border px-4 py-2">
          Browse communities
        </Link>
        <Link to="/feeds" className="rounded-md border px-4 py-2">
          Browse feeds
        </Link>
      </div>
      <p className="mt-10 text-xs text-muted-foreground">
        Local development: seeded accounts are <code>alice.test</code> …{" "}
        <code>erin.test</code>, password <code>password</code>.
      </p>
    </main>
  )
}
