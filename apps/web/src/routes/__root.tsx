import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router"

import appCss from "@workspace/ui/globals.css?url"
import { SidebarProvider, SidebarTrigger } from "@workspace/ui/components/sidebar"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { AppSidebar } from "../components/app-sidebar.tsx"
import { LogoMark } from "../components/logo.tsx"
import { getViewer } from "../server/profile.ts"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Authentiq" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    ],
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
    <TooltipProvider>
      <SidebarProvider defaultOpen={false}>
        <AppSidebar viewer={viewer} />
        {/* Not SidebarInset: that renders a <main>, and every page has its own. */}
        <div className="flex min-h-svh min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
            <SidebarTrigger />
            <Link to="/" className="flex items-center gap-2">
              <LogoMark className="size-7" />
              <span className="font-semibold tracking-tight">authentiq</span>
            </Link>
          </header>
          <Outlet />
        </div>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
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
