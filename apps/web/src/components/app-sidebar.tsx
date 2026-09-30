import {
  BriefcaseIcon,
  HouseIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  RssIcon,
  SignInIcon,
  SignOutIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react"
import * as React from "react"
import { Link, useLocation } from "@tanstack/react-router"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@workspace/ui/components/sidebar"
import { LogoMark } from "./logo.tsx"
import type { Icon } from "@phosphor-icons/react"

type Viewer = { did: string } | null

type Item = {
  label: string
  to: string
  icon: Icon
  /** Paths that count as this section, besides `to` itself. */
  also?: Array<string>
}

const MAIN: Array<Item> = [
  { label: "Home", to: "/", icon: HouseIcon, also: ["/post/"] },
  { label: "Jobs", to: "/jobs", icon: BriefcaseIcon },
  { label: "Communities", to: "/communities", icon: UsersThreeIcon, also: ["/c/"] },
  { label: "Feeds", to: "/feeds", icon: RssIcon },
]

/**
 * The app's navigation: a narrow rail of icons (labels as tooltips), the
 * logo at the top, the account at the bottom. On small screens it is a
 * sheet opened from the top bar in the root layout.
 */
export function AppSidebar({ viewer }: { viewer: Viewer }) {
  const { pathname } = useLocation()
  // On phones the sidebar is a sheet over the page: close it once a link
  // is followed, or it stays covering the page the user asked for.
  const { setOpenMobile } = useSidebar()
  React.useEffect(() => setOpenMobile(false), [pathname, setOpenMobile])
  const active = (item: Item) =>
    item.to === "/"
      ? pathname === "/" || (item.also ?? []).some((p) => pathname.startsWith(p))
      : pathname.startsWith(item.to) ||
        (item.also ?? []).some((p) => pathname.startsWith(p))

  const main = viewer
    ? [...MAIN, { label: "Recruit", to: "/recruit", icon: MagnifyingGlassIcon }]
    : MAIN
  const profilePath = viewer ? `/p/${viewer.did}` : undefined

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/* A plain link, not a menu button: those shrink every icon to 16px. */}
        <Link
          to="/"
          aria-label="authentiq, home"
          className="flex h-10 items-center gap-2 rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <LogoMark />
          <span className="font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            authentiq
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {main.map((item) => (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton
                  tooltip={item.label}
                  isActive={active(item)}
                  render={<Link to={item.to} />}
                >
                  <item.icon />
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {viewer ? (
            <>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="My profile"
                  isActive={
                    pathname === profilePath ||
                    decodeURIComponent(pathname) === profilePath
                  }
                  render={
                    <Link to="/p/$actor" params={{ actor: viewer.did }} />
                  }
                >
                  <UserCircleIcon />
                  <span>My profile</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Edit profile"
                  isActive={pathname.startsWith("/profile")}
                  render={<Link to="/profile/edit" />}
                >
                  <PencilSimpleIcon />
                  <span>Edit profile</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                {/* Signing out is a POST, so it stays a form. */}
                <form method="post" action="/api/auth/logout">
                  <SidebarMenuButton tooltip="Sign out" type="submit">
                    <SignOutIcon />
                    <span>Sign out</span>
                  </SidebarMenuButton>
                </form>
              </SidebarMenuItem>
            </>
          ) : (
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Sign in"
                isActive={pathname.startsWith("/login")}
                render={<Link to="/login" />}
              >
                <SignInIcon />
                <span>Sign in</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
