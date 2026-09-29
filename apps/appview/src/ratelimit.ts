/**
 * Fixed-window-per-key rate limiting, in memory (phase 4's per-DID upload
 * limit, generalised). Per process: it does not survive a restart and is not
 * shared across replicas.
 */
export function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, Array<number>>()
  return {
    limit,
    /** Records a hit for `key` and says whether it is within the limit. */
    allow(key: string) {
      const since = Date.now() - windowMs
      const recent = (hits.get(key) ?? []).filter((at) => at > since)
      if (recent.length >= limit) {
        hits.set(key, recent)
        return false
      }
      recent.push(Date.now())
      hits.set(key, recent)
      if (hits.size > 10_000) {
        for (const [k, v] of hits)
          if (v.every((at) => at <= since)) hits.delete(k)
      }
      return true
    },
  }
}
