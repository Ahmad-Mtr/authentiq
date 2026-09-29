import { describe, expect, test } from "bun:test"
import { AlgoError, keyset, offset } from "./algos.ts"

describe("cursors", () => {
  test("keyset round-trips and refuses junk", () => {
    const row = { sortAt: new Date("2026-09-20T08:00:00Z"), uri: "at://did:plc:x/sh.authentiq.feed.post/3m" }
    expect(keyset.decode(keyset.encode(row))).toEqual(row)
    expect(keyset.decode(undefined)).toBeUndefined()
    expect(() => keyset.decode("nope")).toThrow(AlgoError)
    expect(() => keyset.decode("123::not-a-uri")).toThrow(AlgoError)
  })

  test("ranked feeds page by offset, so no score is ever in a cursor", () => {
    expect(offset.encode(20)).toBe("o:20")
    expect(offset.decode("o:20")).toBe(20)
    expect(offset.decode(undefined)).toBe(0)
    expect(() => offset.decode("0.8431::at://x")).toThrow(AlgoError)
    expect(() => offset.decode("o:-1")).toThrow(AlgoError)
  })
})
