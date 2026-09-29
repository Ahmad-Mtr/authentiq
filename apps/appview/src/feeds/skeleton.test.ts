import { describe, expect, test } from "bun:test"
import { clampSkeleton } from "./skeleton.ts"

const DID = "did:plc:4bmgs4jtk7p2lbgbzjlqjhxp"
const post = (rkey: string) => ({
  $type: "sh.authentiq.feed.defs#skeletonPost",
  post: `at://${DID}/sh.authentiq.feed.post/${rkey}`,
})
const job = (rkey: string) => ({
  $type: "sh.authentiq.feed.defs#skeletonJob",
  job: `at://${DID}/sh.authentiq.job.posting/${rkey}`,
})

describe("clampSkeleton", () => {
  test("keeps posts and jobs in order", () => {
    const s = clampSkeleton({ feed: [post("a"), job("b")], cursor: "c1" }, 10)!
    expect(s.items.map((i) => i.kind)).toEqual(["post", "job"])
    expect(s.cursor).toBe("c1")
  })

  test("drops other kinds, wrong collections, junk and repeats; cuts to limit", () => {
    const s = clampSkeleton(
      {
        feed: [
          post("a"),
          post("a"),
          { $type: "sh.authentiq.feed.defs#skeletonPost", post: `at://${DID}/sh.authentiq.community.declaration/x` },
          { $type: "sh.authentiq.feed.defs#skeletonJob", job: `at://${DID}/sh.authentiq.feed.post/x` },
          { $type: "app.bsky.feed.defs#skeletonFeedPost", post: `at://${DID}/app.bsky.feed.post/x` },
          { post: `at://${DID}/sh.authentiq.feed.post/untyped` },
          "at://nope",
          null,
          post("b"),
          post("c"),
        ],
      },
      2
    )!
    expect(s.items.map((i) => i.uri.split("/").at(-1))).toEqual(["a", "b"])
    expect(s.dropped).toEqual({
      duplicate: 1,
      "not a sh.authentiq.feed.post": 1,
      "not a sh.authentiq.job.posting": 1,
      "unknown item type": 2,
      "not an object": 2,
      "over limit": 1,
    })
  })

  test("passes the cursor through as is, unless it is too long or not a string", () => {
    expect(clampSkeleton({ feed: [], cursor: "x".repeat(512) }, 5)!.cursor).toHaveLength(512)
    expect(clampSkeleton({ feed: [], cursor: "x".repeat(513) }, 5)!.cursor).toBeUndefined()
    expect(clampSkeleton({ feed: [], cursor: 7 }, 5)!.cursor).toBeUndefined()
  })

  test("refuses what is not a skeleton", () => {
    expect(clampSkeleton("garbage", 5)).toBeUndefined()
    expect(clampSkeleton({ feed: "nope" }, 5)).toBeUndefined()
    expect(clampSkeleton(null, 5)).toBeUndefined()
  })
})
