import { sh } from "@workspace/lexicons"
import { currentDatetimeString } from "@workspace/atproto"
import { checkApplyUrl, checkCloseDate } from "@workspace/rules/posting"
import { salaryIssues } from "@workspace/rules/salary"
import { z } from "zod"
import {
  POST_MAX_BYTES,
  POST_MAX_GRAPHEMES,
  graphemeLength,
  utf8Length,
} from "../lib/richtext.ts"

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

// --- Social records (phase 6) ------------------------------------------------

const POST = sh.authentiq.feed.post
const LIKE = sh.authentiq.feed.like
const FOLLOW = sh.authentiq.graph.follow
const COMMUNITY = sh.authentiq.community.declaration
const MEMBERSHIP = sh.authentiq.community.membership

const atUri = (collection?: string) =>
  z
    .string()
    .regex(/^at:\/\/[^/]+\/[^/]+\/[^/]+$/, "Not an AT-URI")
    .refine((u) => !collection || u.split("/")[3] === collection, {
      message: collection ? `Must be a ${collection} record` : undefined,
    })

/**
 * Long-form text first: up to 3000 graphemes (what the composer counts),
 * and the lexicon's byte cap alongside. The AppView drops anything over
 * either, so the form refuses it before it reaches the repo.
 */
export const postInput = z.object({
  text: z
    .string()
    .refine((t) => t.trim().length > 0, "Write something first")
    .refine(
      (t) => graphemeLength(t) <= POST_MAX_GRAPHEMES,
      `At most ${POST_MAX_GRAPHEMES} characters`
    )
    .refine(
      (t) => utf8Length(t) <= POST_MAX_BYTES,
      `At most ${POST_MAX_BYTES} bytes`
    ),
  /** The post being answered; its thread root is looked up. */
  replyTo: atUri(POST.$nsid).optional(),
  /** A community declaration, for a top-level post. */
  community: atUri(COMMUNITY.$nsid).optional(),
  link: z
    .object({
      uri: z.url({ protocol: /^https?$/ }).max(3000),
      title: z.string().trim().min(1).max(300),
      description: optionalText(1000),
    })
    .optional(),
})

export const likeInput = z.object({ subject: atUri(POST.$nsid) })
export const followInput = z.object({
  /** Handle or DID. */
  subject: z.string().trim().min(3).max(253),
})
export const deleteInput = z.object({ uri: atUri() })

export const communityInput = z.object({
  name: z.string().trim().min(1).max(64),
  topic: z.string().trim().min(1).max(64),
  description: optionalText(1000),
  /** One rule per line. */
  rules: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split("\n")
            .map((r) => r.trim())
            .filter(Boolean)
            .slice(0, 20)
        : undefined
    )
    .pipe(z.array(z.string().max(300)).optional()),
})
export const membershipInput = z.object({
  community: atUri(COMMUNITY.$nsid),
})
export const hideInput = z.object({
  community: atUri(COMMUNITY.$nsid),
  post: atUri(POST.$nsid),
  hidden: z.boolean(),
})

type StrongRef = { uri: string; cid: string }

export const buildPostRecord = (data: {
  text: string
  facets?: sh.authentiq.feed.post.Main["facets"]
  reply?: { root: StrongRef; parent: StrongRef }
  community?: StrongRef
  link?: { uri: string; title: string; description?: string }
}) =>
  POST.$parse({
    $type: POST.$type,
    text: data.text,
    facets: data.facets?.length ? data.facets : undefined,
    reply: data.reply,
    community: data.community,
    embed: data.link
      ? { $type: sh.authentiq.embed.external.$type, external: data.link }
      : undefined,
    createdAt: currentDatetimeString(),
  })

export const buildLikeRecord = (subject: StrongRef) =>
  LIKE.$parse({
    $type: LIKE.$type,
    subject,
    createdAt: currentDatetimeString(),
  })

export const buildFollowRecord = (subject: string) =>
  FOLLOW.$parse({
    $type: FOLLOW.$type,
    subject,
    createdAt: currentDatetimeString(),
  })

export const buildCommunityRecord = (data: z.output<typeof communityInput>) =>
  COMMUNITY.$parse({
    $type: COMMUNITY.$type,
    ...data,
    createdAt: currentDatetimeString(),
  })

export const buildMembershipRecord = (community: StrongRef) =>
  MEMBERSHIP.$parse({
    $type: MEMBERSHIP.$type,
    community,
    createdAt: currentDatetimeString(),
  })

// --- Job postings (phase 7) ----------------------------------------------------

const JOB = sh.authentiq.job.posting

/** A form number: blank is "missing", anything else must parse. */
const formNumber = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
  z.number().optional()
)

/**
 * The posting form. The salary rules are the AppView's own
 * (@workspace/rules/salary), so the form refuses exactly what the indexer
 * would drop, field by field, before anything reaches the repo.
 */
export const jobInput = z
  .object({
    title: z.string().trim().min(1, "Give the role a title").max(100),
    organization: z.string().trim().min(1, "Say who is hiring").max(100),
    description: z
      .string()
      .trim()
      .min(1, "Describe the role")
      .max(5000, "At most 5000 characters"),
    location: optionalText(100),
    locationType: z.enum(["onsite", "hybrid", "remote"]).optional(),
    employmentType: z
      .enum([
        "full-time",
        "part-time",
        "contract",
        "internship",
        "freelance",
        "volunteer",
      ])
      .optional(),
    skills: skillList.pipe(z.array(z.string().max(40)).max(25).optional()),
    salary: z.object({
      min: formNumber,
      max: formNumber,
      currency: z
        .string()
        .trim()
        .transform((c) => c.toUpperCase()),
      period: z.string().trim(),
    }),
    applyUrl: optionalText(2000),
    closeDate: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined)),
  })
  .superRefine((v, ctx) => {
    for (const issue of salaryIssues(v.salary)) {
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path: issue.field === "salary" ? ["salary"] : ["salary", issue.field],
      })
    }
    const close = checkCloseDate(v.closeDate)
    if (close)
      ctx.addIssue({ code: "custom", message: close, path: ["closeDate"] })
    const apply = checkApplyUrl(v.applyUrl)
    if (apply)
      ctx.addIssue({ code: "custom", message: apply, path: ["applyUrl"] })
  })

export const jobUpdateInput = z.object({ uri: atUri(JOB.$nsid) }).and(jobInput)

/**
 * The record, validated against the lexicon as well. `createdAt` is kept
 * across edits: it is when the posting went up.
 */
export const buildJobRecord = (
  data: z.output<typeof jobInput>,
  createdAt?: string
) =>
  JOB.$parse({
    $type: JOB.$type,
    title: data.title,
    organization: data.organization,
    description: data.description,
    location: data.location,
    locationType: data.locationType,
    employmentType: data.employmentType,
    skills: data.skills?.length ? data.skills : undefined,
    salary: {
      min: data.salary.min,
      max: data.salary.max,
      currency: data.salary.currency,
      period: data.salary.period,
    },
    applyUrl: data.applyUrl,
    closeDate: data.closeDate,
    createdAt: createdAt ?? currentDatetimeString(),
  })
