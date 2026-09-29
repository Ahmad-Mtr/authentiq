import { sh } from "@workspace/lexicons"
import { currentDatetimeString } from "@workspace/atproto"
import { z } from "zod"

/**
 * Input schemas and record builders for the actor records. Shared by the
 * editor's server functions (profile.ts) and the resume import (resume.ts).
 *
 * Kept free of server-only imports on purpose: route files import the
 * server-function modules, and anything those export at top level that
 * reaches session.ts drags the Postgres driver into the browser bundle.
 */

const PROFILE = sh.authentiq.actor.profile
const POSITION = sh.authentiq.actor.position
const EDUCATION = sh.authentiq.actor.education

/** Year or year-month, matching the lexicon's documented date shape. */
const partialDate = z
  .string()
  .regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, "Use YYYY or YYYY-MM")

export const optionalText = (max: number) =>
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

const optionalDate = partialDate
  .optional()
  .or(z.literal("").transform(() => undefined))

/**
 * `endDate` must not be before `startDate`: the AppView drops records that
 * break this (apps/appview/src/indexer/rules.ts), so the editor checks it
 * first. Mixed precision compares by the widest reading, as there: an end of
 * `2024` is not before a start of `2024-06`.
 */
function endNotBeforeStart(v: { startDate?: string; endDate?: string }) {
  if (!v.startDate || !v.endDate) return true
  const earliestStart =
    v.startDate.length === 4 ? `${v.startDate}-01` : v.startDate
  const latestEnd = v.endDate.length === 4 ? `${v.endDate}-12` : v.endDate
  return latestEnd >= earliestStart
}
const dateOrder = {
  message: "End date is before the start date",
  path: ["endDate"],
}

export const profileInput = z.object({
  displayName: z.string().trim().min(1).max(64),
  headline: optionalText(120),
  about: optionalText(2000),
  location: optionalText(100),
  openToWork: z.boolean().default(false),
  skills: skillList,
})

export const positionInput = z
  .object({
    title: z.string().trim().min(1).max(100),
    organization: z.string().trim().min(1).max(100),
    employmentType: optionalText(40),
    locationType: optionalText(40),
    location: optionalText(100),
    startDate: partialDate,
    endDate: optionalDate,
    description: optionalText(2000),
    skills: skillList,
  })
  .refine(endNotBeforeStart, dateOrder)

export const educationInput = z
  .object({
    school: z.string().trim().min(1).max(100),
    degree: optionalText(100),
    fieldOfStudy: optionalText(100),
    startDate: optionalDate,
    endDate: optionalDate,
  })
  .refine(endNotBeforeStart, dateOrder)

/**
 * Record builders. Each validates against the lexicon before anything reaches
 * the PDS, which cannot check our schemas itself. The editor's server
 * functions and the resume import (server/resume.ts) both write through these.
 */
export const buildProfileRecord = (
  data: Omit<sh.authentiq.actor.profile.Main, "$type">
) =>
  PROFILE.$parse({
    ...data,
    $type: PROFILE.$type,
    createdAt: data.createdAt ?? currentDatetimeString(),
  })

export const buildPositionRecord = (data: z.output<typeof positionInput>) =>
  POSITION.$parse({
    $type: POSITION.$type,
    ...data,
    createdAt: currentDatetimeString(),
  })

export const buildEducationRecord = (data: z.output<typeof educationInput>) =>
  EDUCATION.$parse({
    $type: EDUCATION.$type,
    ...data,
    createdAt: currentDatetimeString(),
  })
