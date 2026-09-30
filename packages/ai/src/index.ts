import { Mistral } from "@mistralai/mistralai"
import type { RequestOptions } from "@mistralai/mistralai/lib/sdks.js"

export type {
  ChatCompletionStreamRequestMessage as ChatMessage,
  ChatCompletionStreamRequestTool as ChatTool,
  ToolCall,
} from "@mistralai/mistralai/models/components"

/**
 * Model choices per task. Resume parsing (G2) is structured extraction; the
 * recruiting agent (G3) does multi-step tool use; embeddings back talent
 * search (G3).
 *
 * Pinned to dated versions so an alias moving under us cannot shift the eval
 * numbers. Phases 4–8 ran both chat tasks on Ministral 14B because the key
 * had no quota for anything larger. Phase 9 compared them once it did
 * (docs/evals.md): Medium 3.5 parses resumes at F1 98.2% against 95.4%, and
 * passes 17 of 18 agent prompts against 14.7, with no unrequested filters,
 * at about $0.0035 a resume and $0.007 an agent turn. Small 3.2 parsed worse
 * than Ministral (F1 81%: it fills in fields the resume never states).
 */
export const MODELS = {
  resumeParser: "mistral-medium-2604",
  recruitingAgent: "mistral-medium-2604",
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

/**
 * List prices in USD per million tokens, input and output, from
 * mistral.ai/pricing/api on 2026-09-29. Used to report what a run cost, not
 * to bill anyone. Embeddings have no output tokens.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  "ministral-3b-2512": { input: 0.1, output: 0.1 },
  "ministral-8b-2512": { input: 0.15, output: 0.15 },
  "ministral-14b-2512": { input: 0.2, output: 0.2 },
  "mistral-small-2603": { input: 0.15, output: 0.6 },
  "mistral-medium-2604": { input: 1.5, output: 7.5 },
  "mistral-embed-2312": { input: 0.1, output: 0 },
}

/** USD for the given tokens on `model`; NaN when its price is not on file. */
export function costOf(model: string, promptTokens: number, completionTokens = 0) {
  const price = PRICES[model]
  if (!price) return Number.NaN
  return (promptTokens * price.input + completionTokens * price.output) / 1e6
}

export type ModelUsage = {
  calls: number
  promptTokens: number
  completionTokens: number
}

const usage = new Map<string, ModelUsage>()

/**
 * Counts one model response's tokens against `model`, for this process. Every
 * call site that talks to Mistral reports here, so an operator (and
 * `bun run verify:all`) can read what a run actually spent instead of
 * estimating it.
 */
export function recordUsage(
  model: string,
  tokens: { promptTokens?: number | null; completionTokens?: number | null }
) {
  const u = usage.get(model) ?? { calls: 0, promptTokens: 0, completionTokens: 0 }
  u.calls++
  u.promptTokens += tokens.promptTokens ?? 0
  u.completionTokens += tokens.completionTokens ?? 0
  usage.set(model, u)
}

/** Totals since the process started, per model, with their list-price cost. */
export function usageTotals() {
  const models = Object.fromEntries(
    [...usage].map(([model, u]) => [
      model,
      { ...u, costUsd: costOf(model, u.promptTokens, u.completionTokens) },
    ])
  )
  const costUsd = Object.values(models).reduce((sum, m) => sum + m.costUsd, 0)
  return { models, costUsd }
}
