import { eq } from "drizzle-orm"
import type { ChatTool } from "@workspace/ai"
import { schema } from "@workspace/db"
import type { sh } from "@workspace/lexicons"
import { stripQuery } from "@workspace/rules/protected"
import { formatSalary } from "@workspace/rules/salary"
import { z } from "zod"
import { db } from "../db.ts"
import { getPosting, loadPosting } from "../jobs/board.ts"
import { ftsQueryFor, vectorOf } from "../jobs/match.ts"
import { hydrateProfiles, searchTalent } from "../search/talent.ts"
import { loadProfileView } from "../xrpc/getProfile.ts"
import type { Candidate } from "./conversations.ts"

/**
 * The recruiting agent's tools. Each one validates its arguments with zod
 * and calls the same AppView functions the XRPC endpoints use
 * (`searchTalent`, `loadProfileView`, and in phase 7 `getPosting`). The model never writes SQL and never
 * reaches a repo: every tool is read-only, and `draft_outreach` returns
 * material for a draft, not a message.
 *
 * What the model sees about a person leaves out dates and school names, the
 * same proxies the search document leaves out, so it cannot rank on them.
 * Profile text is passed as data; ./loop.ts wraps each result in a
 * delimited block and the system prompt says to treat it as untrusted.
 */

// Strict JSON schemas: every property required, optional ones nullable.
const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>
): ChatTool => ({
  type: "function",
  function: {
    name,
    description,
    strict: true,
    parameters: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  },
})

export const TOOLS: Array<ChatTool> = [
  fn(
    "search_talent",
    "Hybrid search over public professional profiles. Returns candidates ranked by relevance. Put what the recruiter wants in query; set a filter only for a constraint the recruiter actually stated, otherwise null. To find people for one of the recruiter's own job postings, pass its uri as job.",
    {
      query: {
        type: "string",
        description: "The skills, role or experience wanted, in words.",
      },
      job: {
        type: ["string", "null"],
        description:
          "The uri of one of the recruiter's own job postings (at://…/sh.authentiq.job.posting/…) to search for people similar to it; otherwise null.",
      },
      openToWork: {
        type: ["boolean", "null"],
        description:
          "true only if the recruiter asked for people open to work; otherwise null.",
      },
      location: {
        type: ["string", "null"],
        description:
          "A city or country the recruiter named, e.g. 'Berlin'; otherwise null.",
      },
      skills: {
        type: ["array", "null"],
        items: { type: "string" },
        description:
          "Skills the recruiter said are required (each must be listed on the profile); otherwise null. Prefer putting skills in query.",
      },
      limit: {
        type: ["integer", "null"],
        description: "How many, 1-10. null for 8.",
      },
    }
  ),
  fn(
    "get_profile",
    "A candidate's full public profile: headline, about, skills, experience, education.",
    {
      actor: {
        type: "string",
        description: "The candidate's uri, DID or handle.",
      },
    }
  ),
  fn(
    "get_job",
    "A public job posting: title, organization, salary range, location, skills and description.",
    {
      uri: {
        type: "string",
        description:
          "The posting's uri, at://<did>/sh.authentiq.job.posting/<key>.",
      },
    }
  ),
  fn(
    "compare_candidates",
    "Side-by-side profiles of 2-5 candidates, with which of the criteria each one's profile mentions.",
    {
      actors: {
        type: "array",
        items: { type: "string" },
        description: "uris, DIDs or handles.",
      },
      criteria: {
        type: "string",
        description:
          "What matters for the role, e.g. 'Kubernetes, on-call, mentoring'.",
      },
    }
  ),
  fn(
    "draft_outreach",
    "Material for a short outreach message to one candidate. Returns what to write; the draft is for the recruiter to review and send themselves. Nothing is sent.",
    {
      actor: {
        type: "string",
        description: "The candidate's uri, DID or handle.",
      },
      role: {
        type: "string",
        description: "The role you are reaching out about.",
      },
      notes: {
        type: ["string", "null"],
        description: "Anything else to mention.",
      },
    }
  ),
]

export const profileUri = (did: string) =>
  `at://${did}/sh.authentiq.actor.profile/self`

export type ToolOutcome = {
  /** What the model reads. */
  content: unknown
  /** One line for the UI's tool-call card. */
  summary: string
  /** Candidates this result introduced, which the agent may then cite. */
  candidates: Array<Candidate>
  /** Search tool only: the query actually searched, after protected terms were dropped. */
  effectiveQuery?: string
  ignoredTerms?: Array<string>
}

const actorRef = z.string().trim().min(1).max(300)
const jobUri = z
  .string()
  .trim()
  .regex(
    /^at:\/\/[^/]+\/sh\.authentiq\.job\.posting\/[^/]+$/,
    "Not a job posting uri"
  )
const ARGS = {
  search_talent: z
    .object({
      // With a job, the posting is the query; the words are optional.
      query: z.string().trim().max(500),
      job: jobUri.nullable().optional(),
      openToWork: z.boolean().nullable().optional(),
      location: z.string().trim().max(100).nullable().optional(),
      skills: z.array(z.string().trim().max(40)).max(10).nullable().optional(),
      limit: z.number().int().nullable().optional(),
    })
    .refine((a) => a.query !== "" || Boolean(a.job), {
      message: "query is required unless job is given",
    }),
  get_profile: z.object({ actor: actorRef }),
  get_job: z.object({ uri: jobUri }),
  compare_candidates: z.object({
    actors: z.array(actorRef).min(2).max(5),
    criteria: z.string().trim().min(1).max(500),
  }),
  draft_outreach: z.object({
    actor: actorRef,
    role: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(1000).nullable().optional(),
  }),
}

export class ToolArgumentError extends Error {}

/** Who is asking: the conversation's owner. */
export type ToolContext = { caller: string }

/** Runs one tool call. Throws ToolArgumentError for arguments the schema rejects. */
export async function runTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolOutcome> {
  const args =
    typeof rawArgs === "string"
      ? (JSON.parse(rawArgs || "{}") as unknown)
      : rawArgs
  switch (name) {
    case "search_talent": {
      const a = parse(ARGS.search_talent, args)
      // A job posting searches with its own embedding and skills, like
      // similar candidates, and like it only for the posting's author.
      const job = a.job ? await loadPosting(a.job) : undefined
      if (a.job && !job) return jobNotFound(a.job)
      if (job && job.did !== ctx.caller) {
        return {
          content: {
            error:
              "Candidates for a posting are only for its author. Describe the role in query instead.",
            job: a.job,
          },
          summary: "not the recruiter's posting",
          candidates: [],
        }
      }
      const vector = job ? await vectorOf(job.uri) : undefined
      const result = await searchTalent({
        q: job ? ftsQueryFor(job) || a.query : a.query,
        vector: vector ?? undefined,
        filters: {
          openToWork: a.openToWork ?? undefined,
          location: a.location ?? undefined,
          skills: a.skills ?? undefined,
          exclude: job ? [job.did] : undefined,
        },
        limit: Math.min(Math.max(a.limit ?? 8, 1), 10),
      })
      const profiles = await hydrateProfiles(result.hits.map((h) => h.did))
      const results = result.hits.flatMap((h, i) => {
        const p = profiles.get(h.did)
        if (!p) return []
        return [
          {
            rank: i + 1,
            uri: profileUri(h.did),
            handle: p.view.handle,
            displayName: p.view.displayName,
            headline: p.view.headline,
            location: p.view.location,
            openToWork: p.view.openToWork ?? false,
            skills: p.skills,
            matchedBy: h.matchedBy,
          },
        ]
      })
      const ignored = result.ignoredTerms.length
        ? `; ignored ${result.ignoredTerms.map((t) => `“${t}”`).join(", ")}`
        : ""
      const jobRef = job ? await jobCandidate(job.uri) : undefined
      return {
        content: {
          job: jobRef
            ? { uri: jobRef.uri, title: jobRef.displayName }
            : undefined,
          searchedFor: job
            ? `people similar to the posting${vector ? "" : " (not embedded yet: full-text on its skills only)"}`
            : result.effectiveQuery,
          ignoredTerms: result.ignoredTerms.length
            ? {
                terms: result.ignoredTerms,
                reason:
                  "Protected attributes and their proxies are never used to search or rank.",
              }
            : undefined,
          degraded: result.degraded || undefined,
          results,
        },
        summary: `${results.length} candidate(s) for ${jobRef ? `the posting “${jobRef.displayName}”` : `“${result.effectiveQuery}”`}${ignored}`,
        candidates: [
          ...(jobRef ? [jobRef] : []),
          ...results.map((r) => ({
            uri: r.uri,
            did: r.uri.split("/")[2]!,
            handle: r.handle,
            displayName: r.displayName,
          })),
        ],
        effectiveQuery: result.effectiveQuery,
        ignoredTerms: result.ignoredTerms,
      }
    }
    case "get_profile": {
      const a = parse(ARGS.get_profile, args)
      const view = await loadProfileView(toActorId(a.actor))
      if (!view) return notFound(a.actor)
      return {
        content: agentView(view),
        summary: `profile of ${view.displayName ?? view.handle}`,
        candidates: [candidate(view)],
      }
    }
    case "get_job": {
      const a = parse(ARGS.get_job, args)
      const view = await getPosting(a.uri, undefined)
      if (!view) return jobNotFound(a.uri)
      return {
        content: {
          uri: view.uri,
          title: view.title,
          organization: view.organization,
          postedBy: view.author.handle,
          salary: formatSalary(view.salary),
          salaryPerYear:
            view.salary.period === "year"
              ? undefined
              : `${view.salary.currency} ${view.annualSalary.min}–${view.annualSalary.max} a year (full-time assumption)`,
          location: view.location,
          locationType: view.locationType,
          employmentType: view.employmentType,
          skills: view.skills,
          closed: view.closed || undefined,
          closeDate: view.closeDate,
          description: view.description,
        },
        summary: `posting “${view.title}” at ${view.organization}`,
        candidates: [
          {
            kind: "job",
            uri: view.uri,
            did: view.author.did,
            handle: view.author.handle,
            displayName: view.title,
          },
        ],
      }
    }
    case "compare_candidates": {
      const a = parse(ARGS.compare_candidates, args)
      const { text: criteria, removed } = stripQuery(a.criteria)
      const terms = [
        ...new Set(
          criteria
            .split(/[,;]|\band\b/i)
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length > 1)
        ),
      ]
      const views = (
        await Promise.all(a.actors.map((id) => loadProfileView(toActorId(id))))
      ).filter((v): v is NonNullable<typeof v> => v !== null)
      const docs = new Map(
        await Promise.all(
          views.map(async (v) => {
            const [row] = await db
              .select({ document: schema.embedding.document })
              .from(schema.embedding)
              .where(eq(schema.embedding.subject, v.did))
            return [v.did, (row?.document ?? "").toLowerCase()] as const
          })
        )
      )
      return {
        content: {
          criteria: terms,
          ignoredTerms: removed.length ? removed : undefined,
          candidates: views.map((v) => ({
            ...agentView(v),
            // Plain substring checks against the same document search uses.
            criteriaMentioned: terms.filter((t) =>
              docs.get(v.did)?.includes(t)
            ),
          })),
          missing: a.actors.length - views.length || undefined,
        },
        summary: `compared ${views.length} candidate(s) on ${terms.length} criteria`,
        candidates: views.map(candidate),
      }
    }
    case "draft_outreach": {
      const a = parse(ARGS.draft_outreach, args)
      const view = await loadProfileView(toActorId(a.actor))
      if (!view) return notFound(a.actor)
      const notes = a.notes ? stripQuery(a.notes).text : undefined
      return {
        content: {
          recipient: {
            uri: profileUri(view.did),
            displayName: view.displayName,
            headline: view.headline,
            skills: view.skills,
          },
          role: a.role,
          notes,
          instructions:
            "Write a short, specific and respectful first message about the role, referring only to the recipient's professional experience. Present it as a draft for the recruiter to edit and send themselves: nothing has been or will be sent.",
        },
        summary: `outreach draft for ${view.displayName ?? view.handle} (not sent)`,
        candidates: [candidate(view)],
      }
    }
    default:
      throw new ToolArgumentError(`Unknown tool ${name}`)
  }
}

function parse<T>(argsSchema: z.ZodType<T>, args: unknown): T {
  const r = argsSchema.safeParse(args)
  if (!r.success)
    throw new ToolArgumentError(r.error.issues.map((i) => i.message).join("; "))
  return r.data
}

/** A DID, handle or profile AT-URI → what loadProfileView takes. */
function toActorId(ref: string) {
  const m = ref.match(/^at:\/\/([^/]+)/)
  return m ? m[1]! : ref.replace(/^@/, "")
}

function jobNotFound(uri: string): ToolOutcome {
  return {
    content: { error: "Job posting not found", uri },
    summary: "job posting not found",
    candidates: [],
  }
}

/** A posting as something the agent may cite. */
async function jobCandidate(uri: string): Promise<Candidate | undefined> {
  const view = await getPosting(uri, undefined)
  return view
    ? {
        kind: "job",
        uri: view.uri,
        did: view.author.did,
        handle: view.author.handle,
        displayName: view.title,
      }
    : undefined
}

function notFound(ref: string): ToolOutcome {
  return {
    content: { error: "Candidate not found", actor: ref },
    summary: "not found",
    candidates: [],
  }
}

const candidate = (
  v: sh.authentiq.actor.defs.ProfileViewDetailed
): Candidate => ({
  uri: profileUri(v.did),
  did: v.did,
  handle: v.handle,
  displayName: v.displayName,
})

/** The profile as the agent sees it: no dates, no schools. */
function agentView(v: sh.authentiq.actor.defs.ProfileViewDetailed) {
  return {
    uri: profileUri(v.did),
    handle: v.handle,
    displayName: v.displayName,
    headline: v.headline,
    about: v.about,
    location: v.location,
    openToWork: v.openToWork ?? false,
    skills: v.skills,
    experience: (v.positions ?? []).map((p) => ({
      title: p.title,
      organization: p.organization,
      current: p.endDate === undefined,
      employmentType: p.employmentType,
      locationType: p.locationType,
      description: p.description,
    })),
    education: (v.education ?? []).map((e) => ({
      degree: e.degree,
      fieldOfStudy: e.fieldOfStudy,
    })),
  }
}
