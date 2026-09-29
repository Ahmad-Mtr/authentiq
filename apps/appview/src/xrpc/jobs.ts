import { Elysia, status, t } from "elysia"
import { sh } from "@workspace/lexicons"
import { resolveViewer, verifyServiceAuth } from "../auth.ts"
import { BoardError, getPosting, listPostings } from "../jobs/board.ts"
import { matchFor, similarCandidates } from "../jobs/match.ts"
import { createRateLimiter } from "../ratelimit.ts"
import { resolveActor } from "../social/feeds.ts"

/**
 * Phase 7: the job board and the matching features.
 *
 * `listPostings` and `getPosting` are public, like every other query over
 * repo data, and take optional service auth for viewer state.
 * `getSimilarCandidates` and `getMatch` require service auth for their own
 * method: the first answers only a posting's author, the second only ever
 * talks about the caller.
 */

const JOB = sh.authentiq.job

const atUri = t.String({ pattern: "^at://", maxLength: 8192 })
const oneOrMany = (max: number, maxLength: number) =>
  t.Optional(
    t.Union([
      t.String({ maxLength }),
      t.Array(t.String({ maxLength }), { maxItems: max }),
    ])
  )
const list = (v: string | Array<string> | undefined) =>
  v === undefined ? undefined : [v].flat()

// Each similar-candidates request can run a vector search and a full-text search.
const searches = createRateLimiter(60, 60 * 1000)

export const jobRoutes = new Elysia()
  .get(
    `/xrpc/${JOB.listPostings.$lxm}`,
    async ({ query, headers }) => {
      const auth = await resolveViewer(
        headers.authorization,
        JOB.listPostings.$lxm
      )
      if (!("viewer" in auth)) return status(401, auth)
      let author: string | undefined
      if (query.author) {
        author = await resolveActor(query.author)
        // An unknown or deactivated author has no postings on the board.
        if (!author)
          return JOB.listPostings.$output.schema.parse({ postings: [] })
      }
      try {
        return JOB.listPostings.$output.schema.parse(
          await listPostings({
            q: query.q,
            minSalary: query.minSalary,
            currency: query.currency,
            salaryPeriod: query.salaryPeriod,
            locationType: list(query.locationType),
            location: query.location,
            employmentType: list(query.employmentType),
            skills: list(query.skills),
            author,
            sort: query.sort,
            limit: query.limit ?? 30,
            cursor: query.cursor,
            viewer: auth.viewer,
          })
        )
      } catch (err) {
        if (err instanceof BoardError) {
          return status(400, { error: "InvalidRequest", message: err.message })
        }
        throw err
      }
    },
    {
      query: t.Object({
        q: t.Optional(t.String({ maxLength: 200 })),
        minSalary: t.Optional(t.Numeric({ minimum: 1 })),
        currency: t.Optional(t.String({ maxLength: 3 })),
        salaryPeriod: t.Optional(t.String({ maxLength: 10 })),
        locationType: oneOrMany(3, 20),
        location: t.Optional(t.String({ maxLength: 100 })),
        employmentType: oneOrMany(6, 20),
        skills: oneOrMany(10, 40),
        author: t.Optional(t.String({ maxLength: 2048 })),
        sort: t.Optional(t.String({ maxLength: 10 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
        cursor: t.Optional(t.String({ maxLength: 300 })),
      }),
    }
  )
  .get(
    `/xrpc/${JOB.getPosting.$lxm}`,
    async ({ query, headers }) => {
      const auth = await resolveViewer(
        headers.authorization,
        JOB.getPosting.$lxm
      )
      if (!("viewer" in auth)) return status(401, auth)
      const view = await getPosting(query.uri, auth.viewer)
      return (
        view ??
        status(400, {
          error: "PostingNotFound",
          message: `Posting not found: ${query.uri}`,
        })
      )
    },
    { query: t.Object({ uri: atUri }) }
  )
  .get(
    `/xrpc/${JOB.getSimilarCandidates.$lxm}`,
    async ({ query, headers }) => {
      const auth = await verifyServiceAuth(
        headers.authorization,
        JOB.getSimilarCandidates.$lxm
      )
      if (!("did" in auth)) return status(401, auth)
      if (!searches.allow(auth.did)) {
        return status(429, {
          error: "RateLimitExceeded",
          message: `At most ${searches.limit} requests a minute`,
        })
      }
      const result = await similarCandidates({
        posting: query.posting,
        caller: auth.did,
        limit: query.limit ?? 10,
      })
      if ("error" in result) {
        return status(result.status, {
          error: result.error,
          message: result.message,
        })
      }
      return JOB.getSimilarCandidates.$output.schema.parse({
        candidates: result.candidates.map((c) => c.view),
        pending: result.pending || undefined,
      })
    },
    {
      query: t.Object({
        posting: atUri,
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20 })),
      }),
    }
  )
  .get(`/xrpc/${JOB.getMatch.$lxm}`, async ({ request, headers }) => {
    const auth = await verifyServiceAuth(
      headers.authorization,
      JOB.getMatch.$lxm
    )
    if (!("did" in auth)) return status(401, auth)
    // The only parameter is the posting. Anything else (an `actor`, a
    // `did`) is an attempt to ask about someone else, and is refused.
    const params = new URL(request.url).searchParams
    const extra = [...params.keys()].filter((k) => k !== "posting")
    const posting = params.get("posting")
    if (extra.length > 0 || !posting?.startsWith("at://")) {
      return status(400, {
        error: "InvalidRequest",
        message: extra.length
          ? `Unknown parameter ${extra[0]}: a match score is only ever for the signed-in caller`
          : "posting (an at:// URI) is required",
      })
    }
    const result = await matchFor({ posting, caller: auth.did })
    if ("error" in result) {
      return status(result.status, {
        error: result.error,
        message: result.message,
      })
    }
    return JOB.getMatch.$output.schema.parse({
      posting: result.posting,
      label: "label" in result ? result.label : undefined,
      matchedSkills: result.matchedSkills,
      pending: "pending" in result ? result.pending : undefined,
    })
  })
