import { Link } from "@tanstack/react-router"
import { Fragment } from "react"
import { segments } from "../../lib/richtext.ts"
import type { Facet } from "../../lib/richtext.ts"

/**
 * Post text with its facets: mentions link to the profile, links open the
 * page. `dir="auto"` lets Arabic and other right-to-left posts lay out
 * correctly.
 */
export function RichText({
  text,
  facets,
}: {
  text: string
  facets: ReadonlyArray<Facet>
}) {
  return (
    <p
      dir="auto"
      className="text-sm leading-relaxed break-words whitespace-pre-wrap"
    >
      {segments(text, facets).map((s, i) =>
        s.kind === "text" ? (
          <Fragment key={i}>{s.text}</Fragment>
        ) : s.kind === "mention" ? (
          <Link
            key={i}
            to="/p/$actor"
            params={{ actor: s.did }}
            className="font-medium text-primary hover:underline"
          >
            {s.text}
          </Link>
        ) : (
          <a
            key={i}
            href={s.uri}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            className="text-primary underline-offset-2 hover:underline"
          >
            {s.text}
          </a>
        )
      )}
    </p>
  )
}

/**
 * A fixed, timezone-free format, so the server render and the browser's
 * hydration print the same string.
 */
export function formatDate(iso: string) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}
