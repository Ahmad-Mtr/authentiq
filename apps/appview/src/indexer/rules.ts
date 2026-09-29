/**
 * Business rules the lexicons cannot express. Lexicons have no regex
 * constraint, so these run at index time and the AppView is the authority
 * (ADR 0001). The web editor duplicates some of them for UX.
 */

/** `YYYY` or `YYYY-MM`, as documented on the position and education lexicons. */
const PARTIAL_DATE = /^\d{4}(-(0[1-9]|1[0-2]))?$/

/**
 * Checks optional start/end partial dates. Returns a reason when invalid.
 *
 * Mixed precision compares by the widest reading: `2024` as an end date means
 * "some time in 2024", so it is not before a `2024-06` start.
 */
export function checkDateRange(
  startDate: string | undefined,
  endDate: string | undefined
): string | undefined {
  for (const [name, value] of [
    ["startDate", startDate],
    ["endDate", endDate],
  ] as const) {
    if (value !== undefined && !PARTIAL_DATE.test(value)) {
      return `${name} must be YYYY or YYYY-MM (got ${JSON.stringify(value)})`
    }
  }
  if (startDate && endDate) {
    const earliestStart = startDate.length === 4 ? `${startDate}-01` : startDate
    const latestEnd = endDate.length === 4 ? `${endDate}-12` : endDate
    if (latestEnd < earliestStart) {
      return `endDate ${endDate} is before startDate ${startDate}`
    }
  }
  return undefined
}

// --- Social records (phase 6) ------------------------------------------------

/** Long-form text first: the lexicon's limits on `feed.post#text`. */
export const POST_MAX_GRAPHEMES = 3000
export const POST_MAX_BYTES = 30000

const POST_NSID = "sh.authentiq.feed.post"
const COMMUNITY_NSID = "sh.authentiq.community.declaration"

const utf8 = new TextEncoder()
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function graphemeLength(text: string) {
  let n = 0
  for (const _ of graphemes.segment(text)) n++
  return n
}

/**
 * Text limits. The generated lexicon validator already enforces both, so
 * this is a second line that keeps the product rule in one readable place.
 */
export function checkPostText(text: string): string | undefined {
  if (text.trim() === "") return "text is blank"
  const bytes = utf8.encode(text).byteLength
  if (bytes > POST_MAX_BYTES) {
    return `text is ${bytes} bytes (maximum ${POST_MAX_BYTES})`
  }
  const count = graphemeLength(text)
  if (count > POST_MAX_GRAPHEMES) {
    return `text is ${count} graphemes (maximum ${POST_MAX_GRAPHEMES})`
  }
  return undefined
}

type Facet = {
  index: { byteStart: number; byteEnd: number }
  features: Array<{ $type?: string; uri?: unknown }>
}

/**
 * Facet ranges are UTF-8 byte offsets. Each must be a non-empty range inside
 * the text whose ends fall on character boundaries: never inside a
 * multi-byte sequence, where it would split an emoji or an Arabic letter.
 * Links must be http(s), since they are rendered as anchors.
 */
export function checkFacets(
  text: string,
  facets: ReadonlyArray<Facet> | undefined
): string | undefined {
  if (!facets?.length) return undefined
  const bytes = utf8.encode(text)
  // A continuation byte is 0b10xxxxxx; any other position starts a character.
  const onBoundary = (i: number) =>
    i === bytes.length || ((bytes[i] ?? 0) & 0xc0) !== 0x80
  for (const [n, { index, features }] of facets.entries()) {
    const { byteStart, byteEnd } = index
    if (byteStart >= byteEnd) {
      return `facet ${n} is empty or reversed (${byteStart}–${byteEnd})`
    }
    if (byteEnd > bytes.length) {
      return `facet ${n} ends at byte ${byteEnd}, past the text's ${bytes.length}`
    }
    if (!onBoundary(byteStart) || !onBoundary(byteEnd)) {
      return `facet ${n} (${byteStart}–${byteEnd}) splits a character`
    }
    for (const feature of features) {
      if (
        feature.$type === "sh.authentiq.richtext.facet#link" &&
        !isHttpUri(feature.uri)
      ) {
        return `facet ${n} links to a non-http(s) URI`
      }
    }
  }
  return undefined
}

export const isHttpUri = (uri: unknown) =>
  typeof uri === "string" && /^https?:\/\//i.test(uri)

/** Collection and repo of an AT-URI, or undefined if it is not one. */
function parseAtUri(uri: string) {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
  return m ? { repo: m[1]!, collection: m[2]!, rkey: m[3]! } : undefined
}

const pointsAt = (uri: string, collection: string) =>
  parseAtUri(uri)?.collection === collection

type StrongRef = { uri: string; cid: string }

/**
 * What can be checked about a reply from the record alone. Whether the
 * parent really belongs to that root needs the parent, which may not be
 * indexed yet, so that half is checked when a thread is built.
 */
export function checkReply(
  reply: { root: StrongRef; parent: StrongRef } | undefined,
  community: StrongRef | undefined,
  selfUri: string
): string | undefined {
  if (!reply) {
    if (community && !pointsAt(community.uri, COMMUNITY_NSID)) {
      return `community ${community.uri} is not a ${COMMUNITY_NSID}`
    }
    return undefined
  }
  const { root, parent } = reply
  for (const [name, ref] of [
    ["root", root],
    ["parent", parent],
  ] as const) {
    if (!pointsAt(ref.uri, POST_NSID)) {
      return `reply ${name} ${ref.uri} is not a ${POST_NSID}`
    }
    if (ref.uri === selfUri) return `reply ${name} is the post itself`
  }
  if (root.uri === parent.uri && root.cid !== parent.cid) {
    return "reply root and parent name the same post with different CIDs"
  }
  if (community) {
    return "a reply cannot set community; it belongs to its root's community"
  }
  return undefined
}

export const checkLikeSubject = (subject: StrongRef) =>
  pointsAt(subject.uri, POST_NSID)
    ? undefined
    : `like subject ${subject.uri} is not a ${POST_NSID}`

export const checkFollow = (subject: string, author: string) =>
  subject === author ? "an account cannot follow itself" : undefined

export const checkMembership = (community: StrongRef) =>
  pointsAt(community.uri, COMMUNITY_NSID)
    ? undefined
    : `membership points at ${community.uri}, not a ${COMMUNITY_NSID}`

export function checkCommunity(v: { name: string; topic: string }) {
  if (v.name.trim() === "") return "community name is blank"
  if (v.topic.trim() === "") return "community topic is blank"
  return undefined
}

// --- Job postings (phase 7) --------------------------------------------------

/**
 * Salary transparency (G5), enforced here because the PDS stores whatever it
 * is given. A posting is dropped, and an indexed version removed, when it has
 * no salary or a salary missing min, max, currency or period; a minimum of 0
 * or less; a minimum above the maximum; a maximum over 2 × the minimum (a
 * range that says nothing); an unknown ISO 4217 currency or pay period; or a
 * malformed close date or apply link.
 *
 * The rules themselves live in @workspace/rules, which the web form runs
 * too, so there is one definition and the form refuses what we would drop.
 */
export { checkPosting as checkJobPosting } from "@workspace/rules/posting"
