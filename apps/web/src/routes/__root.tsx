import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router"

import appCss from "@workspace/ui/globals.css?url"
import { getViewer } from "../server/profile.ts"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Authentiq" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  loader: () => getViewer(),
  notFoundComponent: () => (
    <main className="container mx-auto p-4 pt-16">
      <h1 className="text-lg font-medium">404</h1>
      <p className="text-muted-foreground">
        The requested page could not be found.
      </p>
    </main>
  ),
  shellComponent: RootDocument,
  component: RootLayout,
})

function RootLayout() {
  const viewer = Route.useLoaderData()
  return (
    <div className="min-h-svh">
      <header className="border-b">
        <nav className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-3 text-sm">
          <Link to="/" className="font-semibold">
            Authentiq
          </Link>
          <span className="text-muted-foreground text-xs">
            professional identity you own
          </span>
          <div className="ml-auto flex items-center gap-3">
            <Link to="/jobs" className="hover:underline">
              Jobs
            </Link>
            <Link to="/communities" className="hover:underline">
              Communities
            </Link>
            {viewer ? (
              <>
                <Link
                  to="/p/$actor"
                  params={{ actor: viewer.did }}
                  className="hover:underline"
                >
                  My profile
                </Link>
                <Link to="/profile/edit" className="hover:underline">
                  Edit
                </Link>
                <Link to="/recruit" className="hover:underline">
                  Recruit
                </Link>
                <form method="post" action="/api/auth/logout">
                  <button className="text-muted-foreground hover:underline">
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <Link to="/login" className="hover:underline">
                Sign in
              </Link>
            )}
          </div>
        </nav>
      </header>
      <Outlet />
    </div>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
