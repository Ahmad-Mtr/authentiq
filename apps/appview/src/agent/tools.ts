import { eq } from "drizzle-orm"
import type { ChatTool } from "@workspace/ai"
import { schema } from "@workspace/db"
import type { sh } from "@workspace/lexicons"
import { z } from "zod"
import { db } from "../db.ts"
import { stripQuery } from "../embed/protected.ts"
import { hydrateProfiles, searchTalent } from "../search/talent.ts"
import { loadProfileView } from "../xrpc/getProfile.ts"
import type { Candidate } from "./conversations.ts"

/**
 * The recruiting agent's tools. Each one validates its arguments with zod
 * and calls the same AppView functions the XRPC endpoints use
 * (`searchTalent`, `loadProfileView`). The model never writes SQL and never
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
    "Hybrid search over public professional profiles. Returns candidates ranked by relevance. Put what the recruiter wants in query; set a filter only for a constraint the recruiter actually stated, otherwise null.",
    {
      query: {
        type: "string",
        description: "The skills, role or experience wanted, in words.",
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
const ARGS = {
  search_talent: z.object({
    query: z.string().trim().min(1).max(500),
    openToWork: z.boolean().nullable().optional(),
    location: z.string().trim().max(100).nullable().optional(),
    skills: z.array(z.string().trim().max(40)).max(10).nullable().optional(),
    limit: z.number().int().nullable().optional(),
  }),
  get_profile: z.object({ actor: actorRef }),
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

/** Runs one tool call. Throws ToolArgumentError for arguments the schema rejects. */
export async function runTool(
  name: string,
  rawArgs: unknown
): Promise<ToolOutcome> {
  const args =
    typeof rawArgs === "string"
      ? (JSON.parse(rawArgs || "{}") as unknown)
      : rawArgs
  switch (name) {
    case "search_talent": {
      const a = parse(ARGS.search_talent, args)
      const result = await searchTalent({
        q: a.query,
        filters: {
          openToWork: a.openToWork ?? undefined,
          location: a.location ?? undefined,
          skills: a.skills ?? undefined,
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
      return {
        content: {
          searchedFor: result.effectiveQuery,
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
        summary: `${results.length} candidate(s) for “${result.effectiveQuery}”${ignored}`,
        candidates: results.map((r) => ({
          uri: r.uri,
          did: r.uri.split("/")[2]!,
          handle: r.handle,
          displayName: r.displayName,
        })),
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
