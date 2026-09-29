import { createFileRoute, redirect, useRouter } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Textarea } from "@workspace/ui/components/textarea"
import { useState } from "react"
import { communityParams, postJson } from "../lib/actions.ts"
import { getViewer } from "../server/profile.ts"

export const Route = createFileRoute("/communities/new")({
  loader: async () => {
    const viewer = await getViewer()
    if (!viewer) throw redirect({ to: "/login" })
    return viewer
  },
  component: NewCommunity,
})

function NewCommunity() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold">Create a community</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        A community is a record in your repo. You will be its only moderator:
        you can hide posts from it, but they stay in their authors' repos.
      </p>
      <form
        className="mt-8 grid gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          const form = new FormData(e.currentTarget)
          setBusy(true)
          setError(null)
          postJson<{ uri: string }>("/api/communities", {
            name: String(form.get("name") ?? ""),
            topic: String(form.get("topic") ?? ""),
            description: String(form.get("description") ?? ""),
            rules: String(form.get("rules") ?? ""),
          })
            .then(({ uri }) =>
              router.navigate({
                to: "/c/$actor/$rkey",
                params: communityParams(uri),
              })
            )
            .catch((err: unknown) =>
              setError(err instanceof Error ? err.message : "Could not create")
            )
            .finally(() => setBusy(false))
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" maxLength={64} required dir="auto" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="topic">Topic</Label>
          <Input
            id="topic"
            name="topic"
            maxLength={64}
            placeholder="e.g. Platform engineering"
            required
            dir="auto"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="description">Description</Label>
          <Textarea id="description" name="description" rows={3} dir="auto" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="rules">Rules (one per line)</Label>
          <Textarea id="rules" name="rules" rows={4} dir="auto" />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={busy} className="justify-self-start">
          {busy ? "Creating…" : "Create community"}
        </Button>
      </form>
    </main>
  )
}
