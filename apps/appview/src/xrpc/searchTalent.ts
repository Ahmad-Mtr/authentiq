import { Elysia, status, t } from "elysia"
import { sh } from "@workspace/lexicons"
import { createRateLimiter } from "../ratelimit.ts"
import {
  SearchUnavailableError,
  hydrateProfiles,
  searchTalent,
} from "../search/talent.ts"
import type { TalentMode } from "../search/talent.ts"

/**
 * sh.authentiq.actor.searchTalent
 *
 * Public, like getProfile: it only reads public repo data. Each distinct
 * query costs an embedding call, so it is rate limited per client IP.
 */

const searches = createRateLimiter(60, 60 * 1000)
const MODES = new Set(["hybrid", "vector", "fts"])

export const searchTalentRoute = new Elysia().get(
  "/xrpc/sh.authentiq.actor.searchTalent",
  async ({ query, request, server }) => {
    const ip = server?.requestIP(request)?.address ?? "unknown"
    if (!searches.allow(ip)) {
      return status(429, {
        error: "RateLimitExceeded",
        message: `At most ${searches.limit} searches a minute`,
      })
    }
    const mode = (query.mode ?? "hybrid") as TalentMode
    if (!MODES.has(mode)) {
      return status(400, {
        error: "InvalidRequest",
        message: `Unknown mode ${mode}`,
      })
    }
    const skills =
      query.skills === undefined ? undefined : [query.skills].flat()
    try {
      const result = await searchTalent({
        q: query.q,
        filters: {
          openToWork:
            query.openToWork === undefined
              ? undefined
              : query.openToWork === "true",
          location: query.location,
          skills,
        },
        mode,
        limit: query.limit,
        offset: query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0,
      })
      const profiles = await hydrateProfiles(result.hits.map((h) => h.did))
      return sh.authentiq.actor.searchTalent.$output.schema.parse({
        cursor:
          result.nextOffset === undefined
            ? undefined
            : String(result.nextOffset),
        results: result.hits.flatMap((h) => {
          const p = profiles.get(h.did)
          return p
            ? [
                {
                  actor: p.view,
                  score: Math.round(h.score * 1e6),
                  matchedBy: h.matchedBy,
                  vectorRank: h.vectorRank,
                  ftsRank: h.ftsRank,
                },
              ]
            : []
        }),
        ignoredTerms: result.ignoredTerms.length
          ? result.ignoredTerms
          : undefined,
        degraded: result.degraded || undefined,
      })
    } catch (err) {
      if (err instanceof SearchUnavailableError) {
        return status(503, {
          error: "SearchUnavailable",
          message: "Vector search is unavailable; try mode=fts or hybrid",
        })
      }
      throw err
    }
  },
  {
    query: t.Object({
      q: t.String({ minLength: 1, maxLength: 500 }),
      openToWork: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])),
      location: t.Optional(t.String({ maxLength: 100 })),
      skills: t.Optional(
        t.Union([
          t.String({ maxLength: 40 }),
          t.Array(t.String({ maxLength: 40 }), { maxItems: 10 }),
        ])
      ),
      mode: t.Optional(t.String()),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50 })),
      cursor: t.Optional(t.String({ maxLength: 16 })),
    }),
  }
)
