import { Button } from "@workspace/ui/components/button"
import { useState } from "react"
import { postJson } from "../../lib/actions.ts"

/** Follow state is the viewer's own; nobody sees a follower count. */
export function FollowButton({
  subject,
  following,
}: {
  subject: string
  following?: string
}) {
  const [uri, setUri] = useState(following)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      if (uri) {
        await postJson("/api/records/delete", { uri })
        setUri(undefined)
      } else {
        setUri(
          (await postJson<{ uri: string }>("/api/follows", { subject })).uri
        )
      }
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
        variant={uri ? "secondary" : "default"}
        aria-pressed={Boolean(uri)}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {uri ? "Following" : "Follow"}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  )
}
