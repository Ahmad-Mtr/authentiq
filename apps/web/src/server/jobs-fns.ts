import { createServerFn } from "@tanstack/react-start"
import { sh } from "@workspace/lexicons"
import { z } from "zod"
import { getSessionAgent } from "./session.ts"
import { fetchBoard, fetchPosting } from "./jobs.ts"

/**
 * Server functions for the job pages' loaders. This module exports only
 * server functions, so route components can import it without pulling the
 * BFF (session, Postgres driver) into the browser bundle.
 */

const POSTING = sh.authentiq.job.posting
const atUri = z.string().regex(/^at:\/\/[^/]+\/[^/]+\/[^/]+$/)

export const boardSearch = z.object({
  q: z.string().max(200).optional(),
  currency: z.string().max(3).optional(),
  minSalary: z.coerce.number().int().positive().optional().catch(undefined),
  salaryPeriod: z.string().max(10).optional(),
  remote: z.coerce.boolean().optional().catch(undefined),
  locationType: z.string().max(20).optional(),
  location: z.string().max(100).optional(),
  employmentType: z.string().max(20).optional(),
  skills: z.string().max(400).optional(),
  sort: z.enum(["newest", "salary"]).optional().catch(undefined),
  cursor: z.string().max(300).optional(),
})

export const getBoard = createServerFn()
  .validator(boardSearch)
  .handler(async ({ data }) => {
    const agent = await getSessionAgent()
    return { ...(await fetchBoard(agent, data)), viewer: agent?.did ?? null }
  })

export const getJobPage = createServerFn()
  .validator(z.object({ uri: atUri }))
  .handler(async ({ data }) => {
    const agent = await getSessionAgent()
    return {
      job: await fetchPosting(agent, data.uri),
      viewer: agent?.did ?? null,
    }
  })

/**
 * The posting as it is in the author's repo, for the edit form. Read from
 * the repo rather than the AppView, so a posting the AppView dropped (say,
 * edited elsewhere to remove its salary) can still be opened and fixed.
 */
export const getJobForEdit = createServerFn()
  .validator(z.object({ uri: atUri }))
  .handler(async ({ data }) => {
    const agent = await getSessionAgent()
    if (!agent) return { state: "signedOut" as const }
    const [, , repo, collection, rkey] = data.uri.split("/")
    if (repo !== agent.did || collection !== POSTING.$nsid) {
      return { state: "notYours" as const }
    }
    const res = await agent.com.atproto.repo
      .getRecord({ repo, collection, rkey: rkey })
      .catch(() => undefined)
    if (!res) return { state: "notFound" as const }
    const v = res.data.value as Record<string, any>
    const salary = (v.salary ?? {}) as Record<string, unknown>
    const str = (x: unknown) => (typeof x === "string" ? x : "")
    return {
      state: "ok" as const,
      uri: data.uri,
      values: {
        title: str(v.title),
        organization: str(v.organization),
        description: str(v.description),
        location: str(v.location),
        locationType: str(v.locationType),
        employmentType: str(v.employmentType),
        skills: Array.isArray(v.skills) ? v.skills.join(", ") : "",
        salaryMin: salary.min === undefined ? "" : String(salary.min),
        salaryMax: salary.max === undefined ? "" : String(salary.max),
        currency: str(salary.currency),
        period: str(salary.period),
        applyUrl: str(v.applyUrl),
        closeDate: str(v.closeDate),
      },
    }
  })
