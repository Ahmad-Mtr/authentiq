import { Link } from "@tanstack/react-router"
import { buttonVariants } from "@workspace/ui/components/button"
import type { GeneratorUI } from "../../lib/feed-types.ts"

/**
 * Home's feed switcher: the timeline ("Home"), then the user's pinned feeds, as
 * links (the URL holds the choice, so it works before hydration and
 * survives a reload).
 */
export function FeedSwitcher({
  pinned,
  selected,
}: {
  pinned: Array<GeneratorUI>
  selected: string | null
}) {
  const tab = (active: boolean) =>
    buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" })
  return (
    <nav className="flex flex-wrap items-center gap-1" aria-label="Feeds">
      <Link
        to="/"
        search={{}}
        className={tab(selected === null)}
        aria-current={selected === null ? "page" : undefined}
      >
        Home
      </Link>
      {pinned.map((g) => (
        <Link
          key={g.uri}
          to="/"
          search={{ feed: g.uri }}
          className={tab(selected === g.uri)}
          aria-current={selected === g.uri ? "page" : undefined}
        >
          {g.displayName}
        </Link>
      ))}
      <Link
        to="/feeds"
        className="ml-auto text-sm text-muted-foreground hover:underline"
      >
        Browse feeds
      </Link>
    </nav>
  )
}
