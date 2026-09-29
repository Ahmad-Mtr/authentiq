import { useRouter } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { useState } from "react"
import { postJson } from "../../lib/actions.ts"

/**
 * Pin or unpin a feed. Pins are private to the user (AppView state behind
 * service auth), so nothing is written to their public repo.
 */
export function PinButton({ feed, pinned }: { feed: string; pinned: boolean }) {
  const router = useRouter()
  const [state, setState] = useState(pinned)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      await postJson("/api/feeds/pins", { feed, pinned: !state })
      setState(!state)
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant={state ? "secondary" : "outline"}
        onClick={toggle}
        disabled={busy}
        aria-pressed={state}
      >
        {state ? "Pinned" : "Pin"}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  )
}
