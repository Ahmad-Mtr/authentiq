import { createServerFn } from "@tanstack/react-start"
import { redirect } from "@tanstack/react-router"
import { sh } from "@workspace/lexicons"
import { z } from "zod"
import {
  buildEducationRecord,
  buildPositionRecord,
  buildProfileRecord,
  educationInput,
  positionInput,
  profileInput,
} from "./records.ts"
import { getSessionAgent, getSessionDid } from "./session.ts"
import { queryAppView } from "./social.ts"

const PROFILE = sh.authentiq.actor.profile
const POSITION = sh.authentiq.actor.position
const EDUCATION = sh.authentiq.actor.education

async function requireAgent() {
  const agent = await getSessionAgent()
  if (!agent?.did) throw redirect({ to: "/login" })
  return agent
}

/** The signed-in user's own records, read from their repo. */
export const getMyRecords = createServerFn().handler(async () => {
  const did = await getSessionDid()
  if (!did) return null
  const agent = await requireAgent()

  const [profile, positions, education] = await Promise.all([
    agent.com.atproto.repo
      .getRecord({ repo: did, collection: PROFILE.$nsid, rkey: "self" })
      .then((r) => r.data.value as Record<string, unknown>)
      .catch(() => undefined),
    agent.com.atproto.repo
      .listRecords({ repo: did, collection: POSITION.$nsid, limit: 100 })
      .then((r) => r.data.records)
      .catch(() => []),
    agent.com.atproto.repo
      .listRecords({ repo: did, collection: EDUCATION.$nsid, limit: 100 })
      .then((r) => r.data.records)
      .catch(() => []),
  ])

  // Only records that satisfy the lexicon are shown; anything else in the repo
  // is ignored, the same rule the AppView applies.
  return {
    did,
    profile: PROFILE.$matches(profile)
      ? {
          displayName: profile.displayName,
          headline: profile.headline,
          about: profile.about,
          location: profile.location,
          openToWork: profile.openToWork ?? false,
          skills: profile.skills ?? [],
        }
      : null,
    positions: positions
      .filter((r) => POSITION.$matches(r.value))
      .map((r) => {
        const v = r.value as sh.authentiq.actor.position.Main
        return {
          uri: r.uri,
          title: v.title,
          organization: v.organization,
          startDate: v.startDate,
          endDate: v.endDate ?? null,
        }
      }),
    education: education
      .filter((r) => EDUCATION.$matches(r.value))
      .map((r) => {
        const v = r.value as sh.authentiq.actor.education.Main
        return {
          uri: r.uri,
          school: v.school,
          degree: v.degree ?? null,
        }
      }),
  }
})

export const saveProfile = createServerFn({ method: "POST" })
  .validator(profileInput)
  .handler(async ({ data }) => {
    const agent = await requireAgent()
    const record = buildProfileRecord({
      displayName: data.displayName,
      headline: data.headline,
      about: data.about,
      location: data.location,
      openToWork: data.openToWork,
      skills: data.skills,
    })
    await agent.com.atproto.repo.putRecord({
      repo: agent.assertDid,
      collection: PROFILE.$nsid,
      rkey: "self",
      record,
    })
    return { ok: true }
  })

export const addPosition = createServerFn({ method: "POST" })
  .validator(positionInput)
  .handler(async ({ data }) => {
    const agent = await requireAgent()
    await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection: POSITION.$nsid,
      record: buildPositionRecord(data),
    })
    return { ok: true }
  })

export const addEducation = createServerFn({ method: "POST" })
  .validator(educationInput)
  .handler(async ({ data }) => {
    const agent = await requireAgent()
    await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection: EDUCATION.$nsid,
      record: buildEducationRecord(data),
    })
    return { ok: true }
  })

/** Deleting a record removes it from the user's repo for good. */
export const deleteRecord = createServerFn({ method: "POST" })
  .validator(z.object({ uri: z.string() }))
  .handler(async ({ data }) => {
    const agent = await requireAgent()
    const parts = data.uri.split("/")
    const collection = parts.at(3)
    const rkey = parts.at(4)
    if (!collection?.startsWith("sh.authentiq.") || !rkey) {
      throw new Error("Refusing to delete a record outside our namespace")
    }
    await agent.com.atproto.repo.deleteRecord({
      repo: agent.assertDid,
      collection,
      rkey,
    })
    return { ok: true }
  })

/**
 * Hydrated profile from the AppView — the read path, per ADR 0001. Signed in,
 * the request carries service auth so it includes whether the viewer
 * follows this actor (phase 6).
 */
export const getProfileView = createServerFn()
  .validator(z.object({ actor: z.string() }))
  .handler(async ({ data }) => {
    const res = await queryAppView<sh.authentiq.actor.defs.ProfileViewDetailed>(
      await getSessionAgent(),
      sh.authentiq.actor.getProfile.$lxm,
      { actor: data.actor }
    )
    return res.ok ? res.data : null
  })

/** Who is signed in, for the nav. */
export const getViewer = createServerFn().handler(async () => {
  const agent = await getSessionAgent()
  if (!agent?.did) return null
  return { did: agent.did }
})
