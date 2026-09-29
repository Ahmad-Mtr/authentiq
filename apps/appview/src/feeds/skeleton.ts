import { AtUri } from "@workspace/atproto"
import {
  BlockedUrlError,
  ResponseTooLargeError,
} from "@workspace/atproto/fetch-guard"
import { sh } from "@workspace/lexicons"
import { feedFetch } from "../fetch.ts"
import { FeedError } from "./resolve.ts"

/**
 * Calls a generator's `getFeedSkeleton` and clamps what comes back. The
 * generator is somebody else's service, so nothing it returns is trusted:
 *
 * - **Transport.** The endpoint goes through the fetch guard (no private
 *   addresses, no redirects). The call times out after 3 s, and a response
 *   over 256 KiB is refused unread.
 * - **Shape.** Anything that is not JSON `{feed: [...]}` fails the feed with
 *   `FeedUnavailable`. Individual items are checked one by one: an item must
 *   be a `#skeletonPost` naming a `feed.post`, or a `#skeletonJob` naming a
 *   `job.posting`. Anything else is dropped (other kinds, other collections,
 *   malformed URIs), as are repeats, and the list is cut to `limit`.
 * - **Cursor.** Passed through untouched, as an opaque string, if it is a
 *   string of at most 512 characters. Otherwise it is dropped, which ends
 *   the feed rather than sending garbage back to the generator.
 *
 * Errors the generator reports are passed on only when they mean something
 * to the client: `UnknownFeed`, and `AuthRequired` for a personalised feed
 * asked for without a viewer. Everything else is `FeedUnavailable`, with a
 * fixed message; the generator's own text is logged, never echoed.
 */

const FEED = sh.authentiq.feed
// Enforced by feedFetch (src/fetch.ts); here for the messages.
const TIMEOUT_MS = 3000
export const MAX_CURSOR = 512

export type SkeletonItem =
  | { kind: "post"; uri: string }
  | { kind: "job"; uri: string }

export type Skeleton = {
  items: Array<SkeletonItem>
  cursor?: string
  /** What was dropped and why, for the log. */
  dropped: Record<string, number>
}

const KINDS = {
  [`${FEED.defs.$nsid}#skeletonPost`]: {
    kind: "post",
    field: "post",
    collection: FEED.post.$nsid,
  },
  [`${FEED.defs.$nsid}#skeletonJob`]: {
    kind: "job",
    field: "job",
    collection: sh.authentiq.job.posting.$nsid,
  },
} as const

/** One raw item → a skeleton item, or the reason it is dropped. */
export function clampItem(raw: unknown): SkeletonItem | string {
  if (!raw || typeof raw !== "object") return "not an object"
  const item = raw as Record<string, unknown>
  const spec = KINDS[String(item.$type)]
  if (!spec) return "unknown item type"
  const value = item[spec.field]
  if (typeof value !== "string" || value.length > 8192) return "no uri"
  let uri: AtUri
  try {
    uri = new AtUri(value)
  } catch {
    return "malformed uri"
  }
  if (uri.collection !== spec.collection || !uri.rkey || !uri.host.startsWith("did:")) {
    return `not a ${spec.collection}`
  }
  return { kind: spec.kind, uri: uri.toString() }
}

/** The whole response → a clamped skeleton, or undefined if it is not one. */
export function clampSkeleton(body: unknown, limit: number): Skeleton | undefined {
  if (!body || typeof body !== "object") return undefined
  const { feed, cursor } = body as { feed?: unknown; cursor?: unknown }
  if (!Array.isArray(feed)) return undefined
  const dropped: Record<string, number> = {}
  const drop = (reason: string) => (dropped[reason] = (dropped[reason] ?? 0) + 1)
  const seen = new Set<string>()
  const items: Array<SkeletonItem> = []
  for (const raw of feed) {
    const item = clampItem(raw)
    if (typeof item === "string") {
      drop(item)
      continue
    }
    if (seen.has(item.uri)) {
      drop("duplicate")
      continue
    }
    if (items.length >= limit) {
      drop("over limit")
      continue
    }
    seen.add(item.uri)
    items.push(item)
  }
  let next: string | undefined
  if (typeof cursor === "string" && cursor.length > 0) {
    if (cursor.length <= MAX_CURSOR) next = cursor
    else drop("cursor too long")
  } else if (cursor !== undefined) {
    drop("cursor not a string")
  }
  return { items, cursor: next, dropped }
}

export async function fetchSkeleton(opts: {
  endpoint: string
  feed: string
  limit: number
  cursor?: string
  /** The viewer's token for the generator, forwarded as is. */
  authorization?: string
}): Promise<Skeleton> {
  const url = new URL(`/xrpc/${FEED.getFeedSkeleton.$lxm}`, opts.endpoint)
  url.searchParams.set("feed", opts.feed)
  url.searchParams.set("limit", String(opts.limit))
  if (opts.cursor) url.searchParams.set("cursor", opts.cursor)

  const unavailable = (message: string, detail: string) =>
    new FeedError(502, "FeedUnavailable", message, detail)

  let res: Response
  try {
    // feedFetch buffers the body, so a too-large or too-slow body fails here.
    res = await feedFetch(url, {
      headers: {
        accept: "application/json",
        ...(opts.authorization ? { authorization: opts.authorization } : {}),
      },
    })
  } catch (err) {
    const e = err as Error
    if (err instanceof BlockedUrlError) {
      throw unavailable(
        err.reason.startsWith("redirect")
          ? "The feed's service redirected, and redirects are not followed"
          : "The feed's endpoint is at an address this AppView will not contact",
        e.message
      )
    }
    if (err instanceof ResponseTooLargeError) {
      throw unavailable("The feed returned too much data", e.message)
    }
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw unavailable("The feed did not answer in time", `timeout after ${TIMEOUT_MS} ms`)
    }
    throw unavailable("The feed could not be reached", `${e.name}: ${e.message}`)
  }

  let body: unknown
  try {
    body = JSON.parse(await res.text())
  } catch {
    throw unavailable("The feed returned an invalid response", `${res.status}, not JSON`)
  }

  if (!res.ok) {
    // JSON `null` parses too, so check before reading a field.
    const error =
      body && typeof body === "object"
        ? (body as { error?: unknown }).error
        : undefined
    if (res.status === 401 && error === "AuthRequired") {
      throw new FeedError(401, "AuthRequired", "Sign in to see this feed")
    }
    if (res.status === 400 && error === "UnknownFeed") {
      throw new FeedError(400, "UnknownFeed", "The feed's service does not serve this feed")
    }
    throw unavailable(
      "The feed's service returned an error",
      `${res.status} ${String(error ?? "")}`.slice(0, 200)
    )
  }

  const skeleton = clampSkeleton(body, opts.limit)
  if (!skeleton) {
    throw unavailable("The feed returned an invalid response", "not a skeleton")
  }
  return skeleton
}
