/**
 * Browser-safe rich-text helpers for posts (phase 6): the composer's live
 * grapheme count and rendering facets back into text. Facets use UTF-8 byte
 * offsets, as Bluesky's do, so rendering slices the encoded bytes rather than
 * the JavaScript (UTF-16) string.
 *
 * No server-only imports here: the composer and the post components load it.
 */

/** Must match the lexicon and the AppView (apps/appview/src/indexer/rules.ts). */
export const POST_MAX_GRAPHEMES = 3000
export const POST_MAX_BYTES = 30000

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** What a reader counts as characters: 👨‍👩‍👧 is one, and so is "é". */
export function graphemeLength(text: string) {
  let n = 0
  for (const _ of segmenter.segment(text)) n++
  return n
}

export const utf8Length = (text: string) => encoder.encode(text).byteLength

export type Facet = {
  index: { byteStart: number; byteEnd: number }
  features: Array<{ $type?: string; did?: string; uri?: string }>
}

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; did: string }
  | { kind: "link"; text: string; uri: string }

/**
 * Splits text into plain, mention and link segments. Facets that overlap an
 * earlier one, fall outside the text, or have no feature we know are
 * rendered as plain text (the AppView already dropped posts with broken
 * ranges; this is the renderer's own guard).
 */
export function segments(text: string, facets: ReadonlyArray<Facet> = []) {
  const bytes = encoder.encode(text)
  const out: Array<Segment> = []
  let cursor = 0
  const sorted = [...facets].sort(
    (a, b) => a.index.byteStart - b.index.byteStart
  )
  for (const facet of sorted) {
    const { byteStart, byteEnd } = facet.index
    if (byteStart < cursor || byteEnd > bytes.length || byteStart >= byteEnd)
      continue
    const mention = facet.features.find(
      (f) => f.$type === "sh.authentiq.richtext.facet#mention" && f.did
    )
    const link = facet.features.find(
      (f) =>
        f.$type === "sh.authentiq.richtext.facet#link" &&
        /^https?:\/\//i.test(f.uri ?? "")
    )
    if (!mention && !link) continue
    if (byteStart > cursor) {
      out.push({
        kind: "text",
        text: decoder.decode(bytes.slice(cursor, byteStart)),
      })
    }
    const slice = decoder.decode(bytes.slice(byteStart, byteEnd))
    out.push(
      mention
        ? { kind: "mention", text: slice, did: mention.did! }
        : { kind: "link", text: slice, uri: link!.uri! }
    )
    cursor = byteEnd
  }
  if (cursor < bytes.length) {
    out.push({ kind: "text", text: decoder.decode(bytes.slice(cursor)) })
  }
  return out
}
