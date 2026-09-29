import { describe, expect, test } from "bun:test"
import { checkCitations } from "./loop.ts"

const ada = {
  uri: "at://did:plc:ada/sh.authentiq.actor.profile/self",
  did: "did:plc:ada",
  handle: "ada.test",
  displayName: "Ada",
}
const conversation = { toolUris: new Map([[ada.uri, ada]]) }

describe("checkCitations", () => {
  test("keeps links to URIs a tool returned", () => {
    const r = checkCitations(`Try [Ada](${ada.uri}).`, conversation)
    expect(r.text).toBe(`Try [Ada](${ada.uri}).`)
    expect(r.citations).toEqual([ada])
    expect(r.dropped).toEqual([])
  })

  test("unlinks invented URIs and reports them", () => {
    const fake = "at://did:plc:ghost/sh.authentiq.actor.profile/self"
    const r = checkCitations(
      `[Ada](${ada.uri}) and [Ghost](${fake}), also ${fake}`,
      conversation
    )
    expect(r.text).toBe(
      `[Ada](${ada.uri}) and Ghost [unverified], also [unverified link removed]`
    )
    expect(r.citations).toEqual([ada])
    expect(r.dropped).toEqual([fake])
  })

  test("a bare at://did for a returned candidate is canonicalised", () => {
    const r = checkCitations(
      `[Ada](at://did:plc:ada) or at://did:plc:ada/`,
      conversation
    )
    expect(r.text).toBe(`[Ada](${ada.uri}) or ${ada.uri}`)
    expect(r.citations).toEqual([ada])
    expect(r.dropped).toEqual([])
  })

  test("a real DID with the wrong path is not the URI the tool returned", () => {
    const r = checkCitations(
      `[Ada](at://did:plc:ada/app.bsky.actor.profile/self)`,
      conversation
    )
    expect(r.citations).toEqual([])
    expect(r.dropped).toHaveLength(1)
  })
})
