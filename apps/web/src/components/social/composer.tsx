import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"
import { useId, useState } from "react"
import { postJson } from "../../lib/actions.ts"
import {
  POST_MAX_BYTES,
  POST_MAX_GRAPHEMES,
  graphemeLength,
  utf8Length,
} from "../../lib/richtext.ts"

/**
 * Writes a post through POST /api/posts. The count is graphemes, what a
 * reader sees as characters: an emoji family or an Arabic letter with its
 * marks counts once. Mentions (@handle) and links become facets on the
 * server, where handles are resolved to DIDs.
 */
export function Composer({
  replyTo,
  community,
  placeholder = "Share something worth reading…",
  submitLabel = "Post",
  onPosted,
  autoFocus,
}: {
  replyTo?: string
  community?: string
  placeholder?: string
  submitLabel?: string
  onPosted?: (uri: string) => void | Promise<void>
  autoFocus?: boolean
}) {
  const id = useId()
  const [text, setText] = useState("")
  const [linkOpen, setLinkOpen] = useState(false)
  const [link, setLink] = useState({ uri: "", title: "", description: "" })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const count = graphemeLength(text)
  const tooLong =
    count > POST_MAX_GRAPHEMES || utf8Length(text) > POST_MAX_BYTES
  const empty = text.trim() === ""

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const { uri } = await postJson<{ uri: string }>("/api/posts", {
        text,
        replyTo,
        community,
        link:
          linkOpen && link.uri
            ? {
                uri: link.uri,
                title: link.title || link.uri,
                description: link.description || undefined,
              }
            : undefined,
      })
      setText("")
      setLink({ uri: "", title: "", description: "" })
      setLinkOpen(false)
      await onPosted?.(uri)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Label htmlFor={`${id}-text`} className="sr-only">
        {submitLabel}
      </Label>
      <Textarea
        id={`${id}-text`}
        dir="auto"
        rows={replyTo ? 3 : 5}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        aria-invalid={tooLong || undefined}
      />
      {linkOpen ? (
        <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-uri`}>Link card URL</Label>
            <Input
              id={`${id}-uri`}
              type="url"
              placeholder="https://…"
              value={link.uri}
              onChange={(e) => setLink({ ...link, uri: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-title`}>Title</Label>
            <Input
              id={`${id}-title`}
              value={link.title}
              onChange={(e) => setLink({ ...link, title: e.target.value })}
            />
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <Label htmlFor={`${id}-desc`}>Description (optional)</Label>
            <Input
              id={`${id}-desc`}
              value={link.description}
              onChange={(e) =>
                setLink({ ...link, description: e.target.value })
              }
            />
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={busy || empty || tooLong}>
          {busy ? "Posting…" : submitLabel}
        </Button>
        {!replyTo ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setLinkOpen(!linkOpen)}
          >
            {linkOpen ? "Remove link card" : "Add link card"}
          </Button>
        ) : null}
        <span
          className={cn(
            "ml-auto text-xs text-muted-foreground tabular-nums",
            tooLong && "font-medium text-destructive"
          )}
          aria-live="polite"
        >
          {count} / {POST_MAX_GRAPHEMES}
        </span>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  )
}
