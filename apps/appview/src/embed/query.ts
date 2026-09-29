import {
  EMBEDDING_DIMENSIONS,
  MODELS,
  getMistral,
  mistralRetries,
} from "@workspace/ai"

/**
 * Embeds search queries, with a small LRU cache: the same query from the
 * eval, the agent, or a user paging through results costs one model call.
 * Retries are short (4 s): a search should fall back to full-text rather
 * than hang when the model is down.
 */

const CACHE_SIZE = 500
const cache = new Map<string, Array<number>>()

export const queryStats = { calls: 0, cacheHits: 0, tokens: 0 }

export async function embedQuery(text: string): Promise<Array<number>> {
  const key = text.trim().toLowerCase()
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    queryStats.cacheHits++
    return hit
  }
  queryStats.calls++
  const res = await getMistral().embeddings.create(
    { model: MODELS.embedding, inputs: [text] },
    { timeoutMs: 10_000, ...mistralRetries(4000) }
  )
  queryStats.tokens += res.usage.promptTokens ?? 0
  const vector = res.data[0]?.embedding
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error("query embedding missing or wrong size")
  }
  cache.set(key, vector)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return vector
}
