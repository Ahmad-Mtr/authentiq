/**
 * End-to-end check of the sh.authentiq.* record lexicons:
 *   1. the generated validators accept good records and reject bad ones
 *   2. a validated record round-trips through a real PDS repo
 *
 *   bun run verify:lexicons
 */
import { sh } from "@workspace/lexicons"
import { LOCAL_NETWORK } from "@workspace/atproto"

const PDS = process.env.PDS_URL ?? LOCAL_NETWORK.pdsUrl
const HANDLE = process.env.VERIFY_HANDLE ?? "alice.test"
const PASSWORD = process.env.VERIFY_PASSWORD ?? "password"

let failures = 0
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
}

// --- 1. validators -----------------------------------------------------------

const profile = sh.authentiq.actor.profile.$build({
  displayName: "Alice Anderson",
  headline: "Backend engineer — distributed systems",
  about: "I build boring infrastructure that stays up.",
  location: "Amman, JO",
  openToWork: true,
  skills: ["TypeScript", "Postgres", "AT Protocol"],
  createdAt: new Date().toISOString(),
})
check(
  sh.authentiq.actor.profile.$matches(profile),
  "profile record validates",
  profile.$type
)

const position = sh.authentiq.actor.position.$build({
  title: "Senior Backend Engineer",
  organization: "Acme",
  employmentType: "full-time",
  locationType: "remote",
  startDate: "2024-06",
  description: "Built the indexing pipeline.",
  skills: ["TypeScript", "Postgres"],
  createdAt: new Date().toISOString(),
})
check(sh.authentiq.actor.position.$matches(position), "position record validates")

const education = sh.authentiq.actor.education.$build({
  school: "University of Jordan",
  degree: "BSc",
  fieldOfStudy: "Computer Science",
  startDate: "2018-09",
  endDate: "2022-06",
  createdAt: new Date().toISOString(),
})
check(sh.authentiq.actor.education.$matches(education), "education record validates")

// Rejections: the lexicon is the contract, so these must not pass.
check(
  !sh.authentiq.actor.profile.$matches({
    $type: "sh.authentiq.actor.profile",
    headline: "No display name",
  }),
  "profile without displayName is rejected"
)
check(
  !sh.authentiq.actor.profile.$matches({
    $type: "sh.authentiq.actor.profile",
    displayName: "A".repeat(65),
  }),
  "displayName over 64 graphemes is rejected"
)
check(
  !sh.authentiq.actor.position.$matches({
    $type: "sh.authentiq.actor.position",
    title: "Engineer",
    organization: "Acme",
    createdAt: new Date().toISOString(),
  }),
  "position without startDate is rejected"
)

// --- 2. round-trip through the PDS -------------------------------------------

async function xrpc(method: string, body: unknown, jwt?: string) {
  const res = await fetch(new URL(`/xrpc/${method}`, PDS), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${method}: ${res.status} ${JSON.stringify(json)}`)
  return json as Record<string, any>
}

const session = await xrpc("com.atproto.server.createSession", {
  identifier: HANDLE,
  password: PASSWORD,
})
const jwt = session.accessJwt as string

const written = await xrpc(
  "com.atproto.repo.putRecord",
  {
    repo: session.did,
    collection: sh.authentiq.actor.profile.$nsid,
    rkey: "self",
    record: profile,
  },
  jwt
)
check(Boolean(written.uri), "profile written to PDS", written.uri)
// The PDS has no schema for our lexicons, so it cannot say more than "unknown".
check(
  written.validationStatus === "unknown",
  "PDS reports validationStatus: unknown",
  String(written.validationStatus)
)

const url = new URL("/xrpc/com.atproto.repo.getRecord", PDS)
url.searchParams.set("repo", session.did)
url.searchParams.set("collection", sh.authentiq.actor.profile.$nsid)
url.searchParams.set("rkey", "self")
const fetched = (await (await fetch(url)).json()) as Record<string, any>
check(
  sh.authentiq.actor.profile.$matches(fetched.value),
  "record read back validates against the lexicon"
)
check(
  fetched.value.displayName === profile.displayName,
  "round-tripped displayName matches"
)

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
