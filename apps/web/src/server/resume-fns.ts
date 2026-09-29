import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { fetchDraft } from "./resume.ts"
import { getSessionAgent } from "./session.ts"

/**
 * Server functions for the resume review page. Kept apart from resume.ts so
 * the page's client bundle only references them, never the BFF internals.
 */
export const getResumeDraft = createServerFn()
  .validator(z.object({ id: z.string().max(64) }))
  .handler(async ({ data }) => {
    const agent = await getSessionAgent()
    return agent ? fetchDraft(agent, data.id) : null
  })
