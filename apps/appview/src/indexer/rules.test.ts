import { describe, expect, test } from "bun:test"
import {
  checkFacets,
  checkFeedGenerator,
  checkFollow,
  checkPostText,
  checkReply,
  graphemeLength,
} from "./rules.ts"

const link = (byteStart: number, byteEnd: number) => ({
  index: { byteStart, byteEnd },
  features: [
    { $type: "sh.authentiq.richtext.facet#link", uri: "https://example.com" },
  ],
})

describe("post text", () => {
  test("counts graphemes, not code units", () => {
    expect(graphemeLength("👨‍👩‍👧")).toBe(1)
    expect(graphemeLength("مرحبا")).toBe(5)
    expect(checkPostText("ب👋🏽".repeat(1500))).toBeUndefined()
    expect(checkPostText("ب👋🏽".repeat(1500) + "x")).toMatch(/3001 graphemes/)
  })
  test("enforces the byte cap alongside", () => {
    expect(checkPostText("👨‍👩‍👧".repeat(2000))).toMatch(/36000 bytes/)
  })
  test("rejects blank text", () => {
    expect(checkPostText(" \n\t")).toBe("text is blank")
  })
})

describe("facets", () => {
  // "مرحبا 👋🏽 x": each Arabic letter is 2 bytes, the space 1, the emoji 8.
  const text = "مرحبا 👋🏽 x"
  test("accepts ranges on character boundaries", () => {
    expect(checkFacets(text, [link(0, 10), link(11, 19)])).toBeUndefined()
  })
  test("rejects a range that splits a character", () => {
    expect(checkFacets(text, [link(1, 4)])).toMatch(/splits a character/)
    expect(checkFacets(text, [link(11, 13)])).toMatch(/splits a character/)
  })
  test("rejects ranges outside the text, empty or reversed", () => {
    expect(checkFacets("hello", [link(2, 50)])).toMatch(/past the text/)
    expect(checkFacets("hello", [link(3, 3)])).toMatch(/empty or reversed/)
  })
  test("rejects non-http links", () => {
    expect(
      checkFacets("hello", [
        {
          index: { byteStart: 0, byteEnd: 5 },
          features: [
            { $type: "sh.authentiq.richtext.facet#link", uri: "javascript:x" },
          ],
        },
      ])
    ).toMatch(/non-http/)
  })
})

describe("replies and follows", () => {
  const post = (rkey: string, cid = "bafyone") => ({
    uri: `at://did:plc:a/sh.authentiq.feed.post/${rkey}`,
    cid,
  })
  const self = "at://did:plc:a/sh.authentiq.feed.post/self"
  test("a direct reply names the same post twice", () => {
    expect(
      checkReply({ root: post("r"), parent: post("r") }, undefined, self)
    ).toBeUndefined()
  })
  test("root and parent must agree on a shared post's CID", () => {
    expect(
      checkReply(
        { root: post("r"), parent: post("r", "bafytwo") },
        undefined,
        self
      )
    ).toMatch(/different CIDs/)
  })
  test("refs must be posts, and not the post itself", () => {
    expect(
      checkReply(
        {
          root: post("r"),
          parent: {
            uri: "at://did:plc:a/sh.authentiq.graph.follow/x",
            cid: "bafyone",
          },
        },
        undefined,
        self
      )
    ).toMatch(/is not a sh.authentiq.feed.post/)
    expect(
      checkReply({ root: post("r"), parent: post("self") }, undefined, self)
    ).toMatch(/the post itself/)
  })
  test("a reply cannot set a community", () => {
    expect(
      checkReply({ root: post("r"), parent: post("r") }, post("c"), self)
    ).toMatch(/cannot set community/)
  })
  test("no self-follows", () => {
    expect(checkFollow("did:plc:a", "did:plc:a")).toMatch(/itself/)
    expect(checkFollow("did:plc:b", "did:plc:a")).toBeUndefined()
  })
})

describe("feed generators", () => {
  const gen = (did: string, displayName = "Feed") => ({ did, displayName })
  test("accepts did:plc and path-less did:web, with or without a port", () => {
    expect(checkFeedGenerator(gen("did:web:localhost%3A2585"))).toBeUndefined()
    expect(checkFeedGenerator(gen("did:web:feeds.example.com"))).toBeUndefined()
    expect(
      checkFeedGenerator(gen("did:plc:4bmgs4jtk7p2lbgbzjlqjhxp"))
    ).toBeUndefined()
  })
  test("leaves address checks to the fetch guard", () => {
    // Syntactically fine; refused when the feed is read, not here.
    expect(checkFeedGenerator(gen("did:web:169.254.169.254"))).toBeUndefined()
  })
  test("rejects DIDs that cannot name a service, and blank names", () => {
    expect(checkFeedGenerator(gen("did:key:z6Mk"))).toMatch(/did:plc/)
    expect(checkFeedGenerator(gen("did:web:host:path"))).toMatch(/path-less/)
    expect(checkFeedGenerator(gen("did:web:localhost%3A2585", "  "))).toMatch(
      /blank/
    )
  })
})
