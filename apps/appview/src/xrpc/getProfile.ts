import { Elysia, status, t } from "elysia"
import { sh } from "@workspace/lexicons"
import {
  getHandle,
  getPdsEndpoint,
  resolveDid,
  resolveHandle,
} from "@workspace/atproto"
import { env } from "../env.ts"

/**
 * sh.authentiq.actor.getProfile
 *
 * Phase 2 implementation: read the actor's records straight from their PDS on
 * every request. Phase 3 replaces this with the firehose-backed index; the
 * lexicon, and therefore the web app, does not change.
 */
export const getProfile = new Elysia().get(
  "/xrpc/sh.authentiq.actor.getProfile",
  async ({ query }) => {
    const actor = query.actor
    let did: string
    try {
      did = actor.startsWith("did:")
        ? actor
        : await resolveHandle(actor, { pdsUrl: env.PDS_URL })
    } catch {
      return status(400, { error: "ActorNotFound", message: `Unknown actor: ${actor}` })
    }

    let doc
    try {
      doc = await resolveDid(did, { plcUrl: env.PLC_URL })
    } catch {
      return status(400, { error: "ActorNotFound", message: `Could not resolve ${did}` })
    }
    const pds = getPdsEndpoint(doc) ?? env.PDS_URL

    const [profile, positions, education] = await Promise.all([
      getRecord(pds, did, sh.authentiq.actor.profile.$nsid, "self"),
      listRecords(pds, did, sh.authentiq.actor.position.$nsid),
      listRecords(pds, did, sh.authentiq.actor.education.$nsid),
    ])

    // Records the lexicon rejects are dropped, exactly as the indexer will do.
    const profileValue = sh.authentiq.actor.profile.$matches(profile?.value)
      ? profile.value
      : undefined

    // Built as a plain object, then parsed through the generated view schema:
    // that validates the branded formats (did, handle, at-uri, datetime) at
    // runtime instead of us asserting them.
    const view = sh.authentiq.actor.defs.profileViewDetailed.parse({
      did,
      handle: getHandle(doc) ?? "handle.invalid",
      displayName: profileValue?.displayName,
      headline: profileValue?.headline,
      about: profileValue?.about,
      location: profileValue?.location,
      openToWork: profileValue?.openToWork,
      skills: profileValue?.skills,
      positions: positions
        .filter((r) => sh.authentiq.actor.position.$matches(r.value))
        .map((r) => {
          const v = r.value as sh.authentiq.actor.position.Main
          return {
            uri: r.uri,
            cid: r.cid,
            title: v.title,
            organization: v.organization,
            employmentType: v.employmentType,
            locationType: v.locationType,
            location: v.location,
            startDate: v.startDate,
            endDate: v.endDate,
            description: v.description,
            skills: v.skills,
          }
        })
        .sort((a, b) => (a.startDate < b.startDate ? 1 : -1)),
      education: education
        .filter((r) => sh.authentiq.actor.education.$matches(r.value))
        .map((r) => {
          const v = r.value as sh.authentiq.actor.education.Main
          return {
            uri: r.uri,
            cid: r.cid,
            school: v.school,
            degree: v.degree,
            fieldOfStudy: v.fieldOfStudy,
            startDate: v.startDate,
            endDate: v.endDate,
            description: v.description,
          }
        }),
      indexedAt: new Date().toISOString(),
    })

    return view
  },
  { query: t.Object({ actor: t.String() }) }
)

type RepoRecord = { uri: string; cid: string; value: unknown }

async function getRecord(
  pds: string,
  repo: string,
  collection: string,
  rkey: string
): Promise<RepoRecord | undefined> {
  const url = new URL("/xrpc/com.atproto.repo.getRecord", pds)
  url.searchParams.set("repo", repo)
  url.searchParams.set("collection", collection)
  url.searchParams.set("rkey", rkey)
  const res = await fetch(url)
  if (!res.ok) return undefined
  return (await res.json()) as RepoRecord
}

async function listRecords(
  pds: string,
  repo: string,
  collection: string
): Promise<Array<RepoRecord>> {
  const url = new URL("/xrpc/com.atproto.repo.listRecords", pds)
  url.searchParams.set("repo", repo)
  url.searchParams.set("collection", collection)
  url.searchParams.set("limit", "100")
  const res = await fetch(url)
  if (!res.ok) return []
  const body = (await res.json()) as { records?: Array<RepoRecord> }
  return body.records ?? []
}
