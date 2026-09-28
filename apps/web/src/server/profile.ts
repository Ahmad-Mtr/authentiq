import { createServerFn } from "@tanstack/react-start"
import { redirect } from "@tanstack/react-router"
import { sh } from "@workspace/lexicons"
import { currentDatetimeString } from "@workspace/atproto"
import { z } from "zod"
import { env } from "./env.ts"
import { getSessionAgent, getSessionDid } from "./session.ts"

const PROFILE = sh.authentiq.actor.profile
const POSITION = sh.authentiq.actor.position
const EDUCATION = sh.authentiq.actor.education

/** Year or year-month, matching the lexicon's documented date shape. */
const partialDate = z
  .string()
  .regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, "Use YYYY or YYYY-MM")

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined))

const skillList = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 50)
      : undefined
  )

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
  .validator(
    z.object({
      displayName: z.string().trim().min(1).max(64),
      headline: optionalText(120),
      about: optionalText(2000),
      location: optionalText(100),
      openToWork: z.boolean().default(false),
      skills: skillList,
    })
  )
  .handler(async ({ data }) => {
    const agent = await requireAgent()

    // Validate against the lexicon before it ever reaches the PDS — the PDS
    // itself cannot check our schemas.
    const record = PROFILE.$parse({
      $type: PROFILE.$type,
      displayName: data.displayName,
      headline: data.headline,
      about: data.about,
      location: data.location,
      openToWork: data.openToWork,
      skills: data.skills,
      createdAt: currentDatetimeString(),
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
  .validator(
    z.object({
      title: z.string().trim().min(1).max(100),
      organization: z.string().trim().min(1).max(100),
      employmentType: optionalText(40),
      locationType: optionalText(40),
      location: optionalText(100),
      startDate: partialDate,
      endDate: partialDate.optional().or(z.literal("").transform(() => undefined)),
      description: optionalText(2000),
      skills: skillList,
    })
  )
  .handler(async ({ data }) => {
    const agent = await requireAgent()
    const record = POSITION.$parse({
      $type: POSITION.$type,
      ...data,
      createdAt: currentDatetimeString(),
    })
    await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection: POSITION.$nsid,
      record,
    })
    return { ok: true }
  })

export const addEducation = createServerFn({ method: "POST" })
  .validator(
    z.object({
      school: z.string().trim().min(1).max(100),
      degree: optionalText(100),
      fieldOfStudy: optionalText(100),
      startDate: partialDate.optional().or(z.literal("").transform(() => undefined)),
      endDate: partialDate.optional().or(z.literal("").transform(() => undefined)),
    })
  )
  .handler(async ({ data }) => {
    const agent = await requireAgent()
    const record = EDUCATION.$parse({
      $type: EDUCATION.$type,
      ...data,
      createdAt: currentDatetimeString(),
    })
    await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection: EDUCATION.$nsid,
      record,
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

/** Hydrated profile from the AppView — the read path, per ADR 0001. */
export const getProfileView = createServerFn()
  .validator(z.object({ actor: z.string() }))
  .handler(async ({ data }) => {
    const url = new URL("/xrpc/sh.authentiq.actor.getProfile", env.APPVIEW_URL)
    url.searchParams.set("actor", data.actor)
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as sh.authentiq.actor.defs.ProfileViewDetailed
  })

/** Who is signed in, for the nav. */
export const getViewer = createServerFn().handler(async () => {
  const agent = await getSessionAgent()
  if (!agent?.did) return null
  return { did: agent.did }
})
