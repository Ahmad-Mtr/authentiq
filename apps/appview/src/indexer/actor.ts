import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { defineCollection } from "./collections.ts"
import { checkDateRange } from "./rules.ts"

/** `sh.authentiq.actor.*` record collections. */

export const profile = defineCollection({
  schema: sh.authentiq.actor.profile,
  table: schema.profile,
  toRow: (v) => ({
    displayName: v.displayName,
    headline: v.headline,
    about: v.about,
    // Legacy blob refs carry the CID as a plain string.
    avatarCid:
      v.avatar && ("ref" in v.avatar ? v.avatar.ref.toString() : v.avatar.cid),
    location: v.location,
    openToWork: v.openToWork,
    skills: v.skills,
    createdAt: v.createdAt ? new Date(v.createdAt) : null,
  }),
})

export const position = defineCollection({
  schema: sh.authentiq.actor.position,
  table: schema.position,
  rules: (v) => checkDateRange(v.startDate, v.endDate),
  toRow: (v) => ({
    title: v.title,
    organization: v.organization,
    employmentType: v.employmentType,
    locationType: v.locationType,
    location: v.location,
    startDate: v.startDate,
    endDate: v.endDate,
    description: v.description,
    skills: v.skills,
    createdAt: new Date(v.createdAt),
  }),
})

export const education = defineCollection({
  schema: sh.authentiq.actor.education,
  table: schema.education,
  rules: (v) => checkDateRange(v.startDate, v.endDate),
  toRow: (v) => ({
    school: v.school,
    degree: v.degree,
    fieldOfStudy: v.fieldOfStudy,
    startDate: v.startDate,
    endDate: v.endDate,
    description: v.description,
    createdAt: new Date(v.createdAt),
  }),
})
