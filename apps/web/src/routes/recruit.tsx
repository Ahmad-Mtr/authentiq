import { Link, createFileRoute, redirect } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import { Fragment, useRef, useState } from "react"
import type { ReactNode } from "react"
import { getViewer } from "../server/profile.ts"

export const Route = createFileRoute("/recruit")({
  loader: async () => {
    const viewer = await getViewer()
    if (!viewer) throw redirect({ to: "/login" })
    return viewer
  },
  component: Recruit,
})

type Candidate = {
  kind?: "actor" | "job"
  uri: string
  did: string
  handle: string
  displayName?: string
}
type ToolCard = {
  id: string
  name: string
  arguments: unknown
  summary?: string
  ignoredTerms?: Array<string>
}
type Turn = {
  question: string
  text: string
  tools: Array<ToolCard>
  final?: { text: string; citations: Array<Candidate>; dropped: Array<string> }
  done?: {
    steps: number
    tokens: { prompt: number; completion: number }
    ms: number
  }
  error?: string
}

const EXAMPLES = [
  "Find senior backend engineers who know Kubernetes",
  "Who could run our design system? Compare the top three.",
  "Draft an outreach message to the best data engineer for a platform role",
]

function Recruit() {
  const [turns, setTurns] = useState<Array<Turn>>([])
  const [conversationId, setConversationId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const update = (fn: (t: Turn) => void) =>
    setTurns((all) => {
      const next = [...all]
      const last = {
        ...next[next.length - 1],
        tools: [...next[next.length - 1].tools],
      }
      fn(last)
      next[next.length - 1] = last
      return next
    })

  const send = async (text: string) => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    setMessage("")
    setTurns((all) => [...all, { question: text, text: "", tools: [] }])
    abort.current = new AbortController()
    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, conversationId }),
        signal: abort.current.signal,
      })
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string
        }
        throw new Error(body.message ?? `Request failed (${res.status})`)
      }
      for await (const { event, data } of readEvents(res.body)) {
        if (event === "turn")
          setConversationId((data as { conversationId: string }).conversationId)
        else if (event === "text")
          update((t) => void (t.text += (data as { delta: string }).delta))
        else if (event === "tool_call")
          update((t) => void t.tools.push(data as ToolCard))
        else if (event === "tool_result") {
          const r = data as ToolCard
          update((t) => {
            t.tools = t.tools.map((c) =>
              c.id === r.id
                ? { ...c, summary: r.summary, ignoredTerms: r.ignoredTerms }
                : c
            )
          })
        } else if (event === "final")
          update((t) => void (t.final = data as Turn["final"]))
        else if (event === "done")
          update((t) => void (t.done = data as Turn["done"]))
        else if (event === "error")
          update((t) => void (t.error = (data as { message: string }).message))
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Something went wrong")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-semibold">Recruiting assistant</h1>
        {turns.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setTurns([])
              setConversationId(undefined)
            }}
          >
            New conversation
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Searches public profiles only. It never uses age, gender, ethnicity,
        religion, disability or other protected attributes, and it drafts
        messages but never sends them.
      </p>

      <div className="mt-8 grid gap-8">
        {turns.map((turn, i) => (
          <TurnView
            key={i}
            turn={turn}
            streaming={busy && i === turns.length - 1}
          />
        ))}
      </div>

      {turns.length === 0 ? (
        <div className="mt-6 flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" onClick={() => setMessage(e)}>
              <Badge variant="outline">{e}</Badge>
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="mt-6 rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <form
        className="mt-6 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void send(message)
        }}
      >
        <Textarea
          aria-label="Message"
          rows={3}
          value={message}
          placeholder="Who are you looking for?"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void send(message)
            }
          }}
        />
        <div className="flex gap-3">
          <Button type="submit" disabled={busy || !message.trim()}>
            {busy ? "Working…" : "Send"}
          </Button>
          {busy ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => abort.current?.abort()}
            >
              Stop
            </Button>
          ) : null}
        </div>
      </form>
    </main>
  )
}

function TurnView({ turn, streaming }: { turn: Turn; streaming: boolean }) {
  const citations = new Map(
    (turn.final?.citations ?? []).map((c) => [c.uri, c])
  )
  return (
    <section className="grid gap-3">
      <p className="justify-self-end rounded-2xl bg-muted px-4 py-2 text-sm">
        {turn.question}
      </p>

      {turn.tools.map((tool) => (
        <details
          key={tool.id}
          className="rounded-md border px-3 py-2 text-sm"
          data-testid="tool-call"
        >
          <summary className="cursor-pointer">
            <Badge variant="secondary">{tool.name}</Badge>{" "}
            <span className="text-muted-foreground">
              {tool.summary ?? "running…"}
            </span>
          </summary>
          <pre className="mt-2 overflow-x-auto text-xs text-muted-foreground">
            {JSON.stringify(tool.arguments, null, 2)}
          </pre>
        </details>
      ))}

      {turn.text || turn.final ? (
        <div
          className="grid gap-2 text-sm leading-relaxed"
          data-testid="answer"
        >
          {renderText(turn.final?.text ?? turn.text, citations, !turn.final)}
        </div>
      ) : streaming ? (
        <p className="text-sm text-muted-foreground">Thinking…</p>
      ) : null}

      {turn.final && turn.final.dropped.length > 0 ? (
        <p className="text-xs text-destructive">
          {turn.final.dropped.length} link(s) did not come from a search result
          and were removed.
        </p>
      ) : null}

      {turn.final && turn.final.citations.length > 0 ? (
        <div className="grid gap-1" data-testid="citations">
          <p className="text-xs text-muted-foreground">Cited</p>
          <ul className="flex flex-wrap gap-2 text-sm">
            {turn.final.citations.map((c) => (
              <li key={c.uri}>
                <CitationLink c={c}>{c.displayName ?? c.handle}</CitationLink>{" "}
                <span className="text-xs text-muted-foreground">
                  {c.kind === "job"
                    ? `posting by @${c.handle}`
                    : `@${c.handle}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {turn.error ? (
        <p className="text-sm text-destructive">{turn.error}</p>
      ) : null}
      {turn.done ? (
        <p className="text-xs text-muted-foreground">
          {turn.done.steps} step(s) ·{" "}
          {turn.done.tokens.prompt + turn.done.tokens.completion} tokens ·{" "}
          {(turn.done.ms / 1000).toFixed(1)} s
        </p>
      ) : null}
    </section>
  )
}

/**
 * Minimal markdown: paragraphs, "-"/"*"/"1." lists, **bold**, and links.
 * An at:// link becomes a profile link only if the server verified it came
 * from a tool result (`citations`); while streaming, before that check, it
 * is shown as plain text.
 */
function renderText(
  text: string,
  citations: Map<string, Candidate>,
  pending: boolean
) {
  const blocks: Array<ReactNode> = []
  let list: Array<ReactNode> = []
  const flush = () => {
    if (list.length)
      blocks.push(
        <ul key={blocks.length} className="ml-5 list-disc">
          {list}
        </ul>
      )
    list = []
  }
  text.split("\n").forEach((line, i) => {
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/)
    if (item) {
      list.push(<li key={i}>{inline(item[1], citations, pending)}</li>)
      return
    }
    flush()
    if (line.trim())
      blocks.push(<p key={`p${i}`}>{inline(line, citations, pending)}</p>)
  })
  flush()
  return blocks
}

function inline(
  text: string,
  citations: Map<string, Candidate>,
  pending: boolean
) {
  const parts: Array<ReactNode> = []
  const re = /\[([^\]]*)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g
  let last = 0
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(last, m.index))
    if (m[0].startsWith("**")) {
      // Bold can wrap a link: **[Name](at://…)**.
      parts.push(
        <strong key={m.index}>{inline(m[3], citations, pending)}</strong>
      )
    } else {
      const c = citations.get(m[2])
      parts.push(
        c ? (
          <CitationLink key={m.index} c={c}>
            {m[1]}
          </CitationLink>
        ) : (
          <Fragment key={m.index}>
            {m[1]}
            {pending ? null : (
              <span className="text-muted-foreground"> (unverified)</span>
            )}
          </Fragment>
        )
      )
    }
    last = m.index + m[0].length
  }
  parts.push(text.slice(last))
  return parts
}

/** Server-sent events from a fetch body (EventSource cannot POST). */
async function* readEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let end
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      let event = "message"
      let data = ""
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7)
        else if (line.startsWith("data: ")) data += line.slice(6)
      }
      if (data) yield { event, data: JSON.parse(data) as unknown }
    }
  }
}

/** A verified citation: a candidate's profile, or a job posting's page (phase 7). */
function CitationLink(props: { c: Candidate; children: ReactNode }) {
  const { c } = props
  if (c.kind === "job") {
    const [, , actor, , rkey] = c.uri.split("/")
    return (
      <Link
        to="/jobs/$actor/$rkey"
        params={{ actor: actor, rkey: rkey }}
        className="underline"
      >
        {props.children}
      </Link>
    )
  }
  return (
    <Link to="/p/$actor" params={{ actor: c.did }} className="underline">
      {props.children}
    </Link>
  )
}
