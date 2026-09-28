import { Link, createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({ component: Home })

function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold">
        A professional network you can take with you
      </h1>
      <p className="text-muted-foreground mt-3 max-w-prose text-sm leading-relaxed">
        Authentiq is built on the AT Protocol. Your profile, roles and posts are
        records in a repository you own, hosted on your own PDS. Authentiq only
        indexes them — leave, and your data goes with you.
      </p>
      <div className="mt-8 flex gap-3 text-sm">
        <Link
          to="/login"
          className="bg-primary text-primary-foreground rounded-md px-4 py-2"
        >
          Sign in with your handle
        </Link>
      </div>
      <p className="text-muted-foreground mt-10 text-xs">
        Local development: seeded accounts are <code>alice.test</code> …{" "}
        <code>erin.test</code>, password <code>password</code>.
      </p>
    </main>
  )
}
