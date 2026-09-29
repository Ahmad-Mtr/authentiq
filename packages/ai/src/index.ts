import { Mistral } from "@mistralai/mistralai"

/**
 * Model choices per task. Resume parsing (G2) is high-volume structured
 * extraction; the recruiting agent (G3) does multi-step tool use; embeddings
 * back talent search (G3).
 *
 * Pinned to dated versions so an alias moving under us cannot shift the
 * phase 4 eval numbers. The account's quota decides what is callable: see
 * docs/phases/04-resume-parsing.md for why the parser is on Ministral.
 */
export const MODELS = {
  resumeParser: "ministral-14b-2512",
  recruitingAgent: "mistral-medium-2604",
  embedding: "mistral-embed-2312",
} as const

/** Output size of `MODELS.embedding`, for the phase 5 pgvector column. */
export const EMBEDDING_DIMENSIONS = 1024

let client: Mistral | undefined

/** Lazily constructed so services without MISTRAL_API_KEY still boot. */
export function getMistral(): Mistral {
  if (!client) {
    const apiKey = process.env.MISTRAL_API_KEY
    if (!apiKey) throw new Error("MISTRAL_API_KEY is not set")
    client = new Mistral({ apiKey })
  }
  return client
}
