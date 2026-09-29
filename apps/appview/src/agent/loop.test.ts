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

describe("checkCitations with job postings (phase 7)", () => {
  const job = {
    kind: "job" as const,
    uri: "at://did:plc:ada/sh.authentiq.job.posting/3mvvqk2qn5s2k",
    did: "did:plc:ada",
    handle: "ada.test",
    displayName: "Site Reliability Engineer",
  }
  const both = { toolUris: new Map([[job.uri, job]]) }

  test("keeps links to postings a tool returned", () => {
    const r = checkCitations(`See [the SRE role](${job.uri}).`, both)
    expect(r.citations).toEqual([job])
    expect(r.dropped).toEqual([])
  })

  test("unlinks a posting no tool returned", () => {
    const fake = "at://did:plc:ada/sh.authentiq.job.posting/3zzzzzzzzzzzz"
    const r = checkCitations(`See [a role](${fake}).`, both)
    expect(r.text).toBe("See a role [unverified].")
    expect(r.dropped).toEqual([fake])
  })

  test("a bare at://did is a person, never their posting", () => {
    const r = checkCitations(`[Ada](at://did:plc:ada)`, both)
    expect(r.citations).toEqual([])
    expect(r.dropped).toEqual(["at://did:plc:ada"])
  })
})
