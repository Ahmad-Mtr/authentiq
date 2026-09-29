import type { Agent } from "@atproto/api"
import { sh } from "@workspace/lexicons"
import type { ActorUI } from "../lib/social-types.ts"
import type { BoardSearch, JobUI, MatchUI } from "../lib/job-types.ts"
import { ApiError, appViewError, callAppView } from "./appview.ts"
import { env } from "./env.ts"
import {
  buildJobRecord,
  deleteInput,
  jobInput,
  jobUpdateInput,
} from "./records.ts"
import { parseInput, queryAppView, waitFor } from "./social.ts"

/**
 * The job board, BFF side (phase 7). Server-only: API routes and server
 * functions import it; route components never do (the phase 4 client-bundle
 * lesson).
 *
 * Writes go to the poster's repo after the same salary rules the AppView
 * applies (records.ts → @workspace/rules), then wait until the AppView shows
 * the change, so the page the poster lands on is current. Reads go to the
 * AppView, with the viewer's service auth when someone is signed in.
 */

const JOB = sh.authentiq.job
const POSTING = JOB.posting

type Json = Record<string, any>

export const toJob = (j: Json): JobUI => ({
  uri: j.uri,
  author: {
    did: j.author.did,
    handle: j.author.handle,
    displayName: j.author.displayName,
    headline: j.author.headline,
  },
  title: j.title,
  organization: j.organization,
  description: j.description,
  location: j.location,
  locationType: j.locationType,
  employmentType: j.employmentType,
  skills: j.skills ?? [],
  salary: j.salary,
  annualSalary: j.annualSalary,
  applyUrl: j.applyUrl,
  closeDate: j.closeDate,
  closed: j.closed,
  createdAt: j.createdAt,
  isAuthor: j.viewer?.isAuthor ?? false,
  ignoredTerms: j.viewer?.ignoredTerms ?? [],
})

// --- reads ---------------------------------------------------------------------

/** Board search params (the page's URL) → listPostings parameters. */
export function boardParams(s: BoardSearch, limit = 20) {
  const skills = (s.skills ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
  const types = s.remote ? ["remote"] : s.locationType ? [s.locationType] : []
  return {
    limit,
    q: s.q || undefined,
    currency: s.currency || undefined,
    minSalary: s.minSalary && s.currency ? s.minSalary : undefined,
    salaryPeriod:
      s.minSalary && s.currency ? (s.salaryPeriod ?? "year") : undefined,
    locationType: types.length ? types : undefined,
    location: s.location || undefined,
    employmentType: s.employmentType ? [s.employmentType] : undefined,
    skills: skills.length ? skills : undefined,
    sort: s.sort === "salary" && s.currency ? "salary" : undefined,
    cursor: s.cursor || undefined,
  }
}

export async function fetchBoard(agent: Agent | undefined, s: BoardSearch) {
  const res = await queryAppView<{ postings: Array<Json>; cursor?: string }>(
    agent,
    JOB.listPostings.$lxm,
    boardParams(s)
  )
  if (!res.ok) {
    return { postings: [], cursor: undefined, error: res.message ?? res.error }
  }
  return {
    postings: res.data.postings.map(toJob),
    cursor: res.data.cursor,
    error: undefined,
  }
}

export async function fetchPosting(agent: Agent | undefined, uri: string) {
  const res = await queryAppView<Json>(agent, JOB.getPosting.$lxm, { uri })
  return res.ok ? toJob(res.data) : null
}

/** The signed-in person's own match with a posting; nobody else's. */
export async function fetchMatch(
  agent: Agent,
  posting: string
): Promise<MatchUI> {
  const res = await callAppView(agent, JOB.getMatch.$lxm, {
    query: { posting },
  })
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (body.error === "ProfileNotFound") return { state: "noProfile" }
    throw new ApiError(400, body.error ?? "InvalidRequest", "Posting not found")
  }
  if (!res.ok) throw await appViewError(res)
  const body = (await res.json()) as {
    label?: "strong" | "partial" | "weak"
    matchedSkills?: Array<string>
    pending?: boolean
  }
  return body.label
    ? {
        state: "match",
        label: body.label,
        matchedSkills: body.matchedSkills ?? [],
      }
    : { state: "pending" }
}

/** Similar candidates, for the posting's author (the AppView refuses anyone else). */
export async function fetchSimilar(agent: Agent, posting: string) {
  const res = await callAppView(agent, JOB.getSimilarCandidates.$lxm, {
    query: { posting, limit: "8" },
  })
  if (!res.ok) throw await appViewError(res)
  const body = (await res.json()) as {
    candidates: Array<Json>
    pending?: boolean
  }
  return {
    pending: body.pending ?? false,
    candidates: body.candidates.map((c): ActorUI & { location?: string } => ({
      did: c.did,
      handle: c.handle,
      displayName: c.displayName,
      headline: c.headline,
      location: c.location,
    })),
  }
}

// --- writes --------------------------------------------------------------------

const publicPosting = async (uri: string) => {
  const url = new URL(`/xrpc/${JOB.getPosting.$lxm}`, env.APPVIEW_URL)
  url.searchParams.set("uri", uri)
  const res = await fetch(url)
  return res.ok ? ((await res.json()) as { cid: string }) : undefined
}

export async function createJob(agent: Agent, raw: unknown) {
  const input = parseInput(jobInput, raw)
  const { data } = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: POSTING.$nsid,
    record: buildJobRecord(input),
  })
  const indexed = await waitFor(
    async () => (await publicPosting(data.uri))?.cid === data.cid
  )
  return { uri: data.uri, cid: data.cid, indexed }
}

/** Your own posting, from your repo, for its createdAt and to prove it exists. */
async function ownPosting(agent: Agent, uri: string) {
  const [, , repo, collection, rkey] = uri.split("/")
  if (collection !== POSTING.$nsid || !rkey) {
    throw new ApiError(400, "InvalidRequest", "Not a job posting")
  }
  if (repo !== agent.assertDid) {
    throw new ApiError(
      403,
      "Forbidden",
      "You can only change your own postings"
    )
  }
  const existing = await agent.com.atproto.repo
    .getRecord({ repo, collection, rkey })
    .catch(() => undefined)
  if (!existing) throw new ApiError(404, "PostingNotFound", "Posting not found")
  return { rkey, value: existing.data.value as { createdAt?: string } }
}

/**
 * Postings are editable, unlike posts: `putRecord` on the same key, with
 * the salary rules checked again first. The AppView re-validates the new
 * version too.
 */
export async function updateJob(agent: Agent, raw: unknown) {
  const input = parseInput(jobUpdateInput, raw)
  const { rkey, value } = await ownPosting(agent, input.uri)
  const { data } = await agent.com.atproto.repo.putRecord({
    repo: agent.assertDid,
    collection: POSTING.$nsid,
    rkey,
    record: buildJobRecord(input, value.createdAt),
  })
  const indexed = await waitFor(
    async () => (await publicPosting(data.uri))?.cid === data.cid
  )
  return { uri: data.uri, cid: data.cid, indexed }
}

export async function deleteJob(agent: Agent, raw: unknown) {
  const { uri } = parseInput(deleteInput, raw)
  const { rkey } = await ownPosting(agent, uri)
  await agent.com.atproto.repo.deleteRecord({
    repo: agent.assertDid,
    collection: POSTING.$nsid,
    rkey,
  })
  const gone = await waitFor(async () => !(await publicPosting(uri)))
  return { deleted: uri, indexed: gone }
}
