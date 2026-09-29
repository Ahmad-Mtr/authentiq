import { Link, createFileRoute, useRouter } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { buttonVariants } from "@workspace/ui/components/button"
import { Composer } from "../components/social/composer.tsx"
import { communityParams, postParams } from "../lib/actions.ts"
import { getCommunities } from "../server/social-fns.ts"

export const Route = createFileRoute("/")({
  loader: () => getCommunities(),
  component: Home,
})

function Home() {
  const { viewer } = Route.useLoaderData()
  return viewer ? <SignedInHome viewer={viewer} /> : <Landing />
}

/**
 * No home timeline until feed composition (phase 8): a feed nobody chose
 * would be ranking by another name. Home is a composer and a way in.
 */
function SignedInHome({ viewer }: { viewer: string }) {
  const { communities } = Route.useLoaderData()
  const router = useRouter()
  const mine = communities.filter((c) => c.isCreator || c.membership)
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

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          to="/p/$actor"
          params={{ actor: viewer }}
          className={buttonVariants({ variant: "outline" })}
        >
          Your posts
        </Link>
        <Link
          to="/communities"
          className={buttonVariants({ variant: "outline" })}
        >
          Browse communities
        </Link>
      </div>

      <section className="mt-10">
        <h2 className="font-medium">Your communities</h2>
        <ul className="mt-3 grid gap-2">
          {mine.map((c) => (
            <li key={c.uri} className="flex items-center gap-2 text-sm">
              <Link
                to="/c/$actor/$rkey"
                params={communityParams(c.uri)}
                className="font-medium hover:underline"
              >
                {c.name}
              </Link>
              <Badge variant="outline">{c.topic}</Badge>
              {c.isCreator ? (
                <span className="text-xs text-muted-foreground">creator</span>
              ) : null}
            </li>
          ))}
          {mine.length === 0 ? (
            <li className="text-sm text-muted-foreground">
              None yet.{" "}
              <Link to="/communities" className="underline">
                Find one to join
              </Link>
              .
            </li>
          ) : null}
        </ul>
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
      </div>
      <p className="mt-10 text-xs text-muted-foreground">
        Local development: seeded accounts are <code>alice.test</code> …{" "}
        <code>erin.test</code>, password <code>password</code>.
      </p>
    </main>
  )
}
