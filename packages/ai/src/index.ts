import { Mistral } from "@mistralai/mistralai"
import type { RequestOptions } from "@mistralai/mistralai/lib/sdks.js"

export type {
  ChatCompletionStreamRequestMessage as ChatMessage,
  ChatCompletionStreamRequestTool as ChatTool,
  ToolCall,
} from "@mistralai/mistralai/models/components"

/**
 * Model choices per task. Resume parsing (G2) is high-volume structured
 * extraction; the recruiting agent (G3) does multi-step tool use; embeddings
 * back talent search (G3).
 *
 * Pinned to dated versions so an alias moving under us cannot shift the eval
 * numbers. The account's quota decides what is callable: `mistral-medium-*`
 * has none yet, so the agent runs on Ministral 14B until it does. Switching is
 * this one line (see docs/phases/05-talent-search.md).
 */
export const MODELS = {
  resumeParser: "ministral-14b-2512",
  recruitingAgent: "ministral-14b-2512",
  embedding: "mistral-embed-2312",
} as const

/** Output size of `MODELS.embedding`, the pgvector column's dimension. */
export const EMBEDDING_DIMENSIONS = 1024

/**
 * Retry policy for Mistral calls: exponential backoff on 429 and 5xx
 * (including "backend out of capacity") and on connection errors, for at most
 * `maxElapsedMs`.
 */
export function mistralRetries(maxElapsedMs = 60_000): RequestOptions {
  return {
    retries: {
      strategy: "backoff",
      backoff: {
        initialInterval: 1000,
        maxInterval: 8000,
        exponent: 2,
        maxElapsedTime: maxElapsedMs,
      },
      retryConnectionErrors: true,
    },
    retryCodes: ["429", "5XX"],
  }
}

let client: Mistral | undefined
let serverURL = process.env.MISTRAL_SERVER_URL || undefined

/** Lazily constructed so services without MISTRAL_API_KEY still boot. */
export function getMistral(): Mistral {
  if (!client) {
    const apiKey = process.env.MISTRAL_API_KEY
    if (!apiKey) throw new Error("MISTRAL_API_KEY is not set")
    client = new Mistral({ apiKey, serverURL })
  }
  return client
}

/**
 * Points the client at another base URL, or back at Mistral with
 * `undefined`. The AppView's admin routes use it to simulate an outage
 * (`bun run verify:search`).
 */
export function setMistralServerURL(url: string | undefined) {
  serverURL = url || undefined
  client = undefined
}

export const getMistralServerURL = () => serverURL
