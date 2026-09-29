import { useEffect, useState } from "react"

/**
 * GETs a JSON API route, and again every `everyMs` while `pending(result)`
 * says the AppView is still catching up (a posting or profile embeds about a
 * second after it is written). Gives up after `tries` and keeps the last
 * answer. "error" for a failed request.
 */
export function usePolled<T>(
  url: string,
  pending: (value: T) => boolean,
  { everyMs = 1500, tries = 20 } = {}
) {
  const [state, setState] = useState<T | "error" | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (left: number) => {
      fetch(url)
        .then(async (r) =>
          r.ok ? ((await r.json()) as T) : ("error" as const)
        )
        .catch(() => "error" as const)
        .then((value) => {
          if (cancelled) return
          setState(value)
          if (value !== "error" && pending(value) && left > 1) {
            timer = setTimeout(() => load(left - 1), everyMs)
          }
        })
    }
    setState(null)
    load(tries)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // `pending` is a predicate on the result, not a reason to fetch again.
  }, [url, everyMs, tries])
  return state
}
