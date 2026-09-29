import {
  Link,
  createFileRoute,
  redirect,
  useNavigate,
} from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Separator } from "@workspace/ui/components/separator"
import { Textarea } from "@workspace/ui/components/textarea"
import { useState } from "react"
import { getMyRecords } from "../server/profile.ts"
import { getResumeDraft } from "../server/resume-fns.ts"
import type { ConfirmInput, DraftView } from "../server/resume.ts"

export const Route = createFileRoute("/profile/import")({
  validateSearch: (search: Record<string, unknown>) => ({
    draft: typeof search.draft === "string" ? search.draft : undefined,
  }),
  loaderDeps: ({ search }) => ({ draft: search.draft }),
  loader: async ({ deps }) => {
    const records = await getMyRecords()
    if (!records) throw redirect({ to: "/login" })
    const draft = deps.draft
      ? await getResumeDraft({ data: { id: deps.draft } })
      : null
    return { records, draft, expired: Boolean(deps.draft && !draft) }
  },
  component: ImportResume,
})

type Records = NonNullable<Awaited<ReturnType<typeof getMyRecords>>>
type Issue = { path: string; message: string }

function ImportResume() {
  const { records, draft, expired } = Route.useLoaderData()
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold">Import from a resume</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your resume goes to Authentiq's AppView for parsing, never to your
        public repo, and is deleted as soon as it has been read. Nothing is
        added to your profile until you confirm it below.
      </p>
      {draft ? (
        <Review key={draft.id} draft={draft} records={records} />
      ) : (
        <Upload expired={expired} />
      )}
    </main>
  )
}

function Upload({ expired }: { expired: boolean }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(
    expired ? "That import has expired. Upload the resume again." : null
  )

  return (
    <form
      className="mt-8 grid gap-4 rounded-md border p-4"
      onSubmit={async (e) => {
        e.preventDefault()
        const file = new FormData(e.currentTarget).get("resume")
        if (!(file instanceof File) || file.size === 0) {
          setError("Choose a PDF or DOCX file")
          return
        }
        if (file.size > 5 * 1024 * 1024) {
          setError("Resumes are limited to 5 MB")
          return
        }
        setBusy(true)
        setError(null)
        try {
          const res = await fetch("/api/resume/upload", {
            method: "POST",
            headers: {
              "content-type": file.type || "application/octet-stream",
            },
            body: file,
          })
          const body = (await res.json()) as DraftView & { message?: string }
          if (!res.ok) throw new Error(body.message ?? "Upload failed")
          await navigate({ to: "/profile/import", search: { draft: body.id } })
        } catch (err) {
          setError(err instanceof Error ? err.message : "Upload failed")
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="resume">Resume (PDF or DOCX, up to 5 MB)</Label>
        <Input
          id="resume"
          name="resume"
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          required
        />
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button type="submit" disabled={busy} className="justify-self-start">
        {busy ? "Reading your resume…" : "Parse resume"}
      </Button>
    </form>
  )
}

const PROFILE_FIELDS = [
  { key: "displayName", label: "Display name" },
  { key: "headline", label: "Headline" },
  { key: "about", label: "About", long: true },
  { key: "location", label: "Location" },
] as const
type ProfileKey = (typeof PROFILE_FIELDS)[number]["key"]

const POSITION_FIELDS = [
  { key: "title", label: "Title", required: true },
  { key: "organization", label: "Organization", required: true },
  { key: "startDate", label: "Start (YYYY or YYYY-MM)", required: true },
  { key: "endDate", label: "End (blank = current)" },
  { key: "location", label: "Location" },
  { key: "employmentType", label: "Employment type" },
  { key: "locationType", label: "Onsite / hybrid / remote" },
] as const
const EDUCATION_FIELDS = [
  { key: "school", label: "School", required: true },
  { key: "degree", label: "Degree" },
  { key: "fieldOfStudy", label: "Field of study" },
  { key: "startDate", label: "Start" },
  { key: "endDate", label: "End" },
] as const

type Entry = { accept: boolean; values: Record<string, string> }

const same = (a?: string | null, b?: string | null) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase()

/**
 * Starting state. Entries are additive, so they start accepted unless the
 * profile already lists the same one. A proposed profile field would replace
 * the current value, so it starts accepted only when that value is empty.
 */
function initialState(draft: DraftView, records: Records) {
  const current = records.profile
  const profile = Object.fromEntries(
    PROFILE_FIELDS.map(({ key }) => {
      const value = draft.draft.profile[key] ?? ""
      return [key, { accept: Boolean(value) && !current?.[key], value }]
    })
  ) as Record<ProfileKey, { accept: boolean; value: string }>
  const skills = (draft.draft.profile.skills ?? []).map((name) => ({
    name,
    accept: !current?.skills.some((s) => same(s, name)),
  }))
  const positions: Array<Entry> = draft.draft.positions.map((p) => ({
    accept: !records.positions.some(
      (r) => same(r.title, p.title) && same(r.organization, p.organization)
    ),
    values: Object.fromEntries(
      POSITION_FIELDS.map(({ key }) => [key, p[key] ?? ""]).concat([
        ["description", p.description ?? ""],
      ])
    ),
  }))
  const education: Array<Entry> = draft.draft.education.map((e) => ({
    accept: !records.education.some(
      (r) => same(r.school, e.school) && same(r.degree, e.degree)
    ),
    values: Object.fromEntries(
      EDUCATION_FIELDS.map(({ key }) => [key, e[key] ?? ""])
    ),
  }))
  return { profile, skills, positions, education }
}

function Review({ draft, records }: { draft: DraftView; records: Records }) {
  const navigate = useNavigate()
  const [state, setState] = useState(() => initialState(draft, records))
  const [busy, setBusy] = useState<"save" | "discard" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [issues, setIssues] = useState<Array<Issue>>([])

  const update = (fn: (s: typeof state) => void) =>
    setState((s) => {
      const next = structuredClone(s)
      fn(next)
      return next
    })

  const acceptedCount =
    PROFILE_FIELDS.filter(({ key }) => state.profile[key].accept).length +
    state.skills.filter((s) => s.accept).length +
    state.positions.filter((p) => p.accept).length +
    state.education.filter((e) => e.accept).length

  const save = async () => {
    // Issues come back indexed by the accepted list, so keep the mapping to
    // draft entries to show each one where it belongs.
    const positionIdx = state.positions.flatMap((p, i) => (p.accept ? [i] : []))
    const educationIdx = state.education.flatMap((e, i) =>
      e.accept ? [i] : []
    )
    const skills = state.skills.filter((s) => s.accept).map((s) => s.name)
    const body: ConfirmInput = {
      draftId: draft.id,
      profile: {
        ...Object.fromEntries(
          PROFILE_FIELDS.filter(({ key }) => state.profile[key].accept).map(
            ({ key }) => [key, state.profile[key].value]
          )
        ),
        ...(skills.length > 0 ? { skills } : {}),
      },
      positions: positionIdx.map((i) => state.positions[i].values as never),
      education: educationIdx.map((i) => state.education[i].values as never),
    }
    setBusy("save")
    setError(null)
    setIssues([])
    try {
      const res = await fetch("/api/resume/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = (await res.json()) as {
        message?: string
        issues?: Array<Issue>
      }
      if (!res.ok) {
        setError(result.message ?? "Could not save")
        setIssues(
          (result.issues ?? []).map((i) => {
            const [list, n, ...rest] = i.path.split(".")
            const map = list === "positions" ? positionIdx : educationIdx
            return list === "positions" || list === "education"
              ? { ...i, path: [list, map[Number(n)], ...rest].join(".") }
              : i
          })
        )
        return
      }
      await navigate({ to: "/profile/edit" })
    } catch {
      setError("Could not save")
    } finally {
      setBusy(null)
    }
  }

  const discard = async () => {
    setBusy("discard")
    await fetch("/api/resume/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: draft.id }),
    }).catch(() => {})
    setBusy(null)
    await navigate({ to: "/profile/import", search: { draft: undefined } })
  }

  const issueFor = (path: string) =>
    issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`))

  return (
    <div className="mt-8">
      <p className="text-sm text-muted-foreground">
        Review each proposal. Untick anything you don't want, and fix anything
        the parser got wrong. This draft is deleted at{" "}
        {new Date(draft.expiresAt).toLocaleTimeString()}, or as soon as you save
        or discard it.
      </p>

      <section className="mt-8 grid gap-4">
        <h2 className="font-medium">Profile</h2>
        {PROFILE_FIELDS.map((f) => {
          const field = state.profile[f.key]
          const current = records.profile?.[f.key]
          if (!field.value && !current) return null
          return (
            <div key={f.key} className="grid gap-2">
              <Label>
                <Checkbox
                  checked={field.accept}
                  onCheckedChange={(v) =>
                    update((s) => void (s.profile[f.key].accept = v))
                  }
                />
                {f.label}
              </Label>
              {"long" in f ? (
                <Textarea
                  rows={4}
                  value={field.value}
                  disabled={!field.accept}
                  onChange={(e) =>
                    update(
                      (s) => void (s.profile[f.key].value = e.target.value)
                    )
                  }
                />
              ) : (
                <Input
                  value={field.value}
                  disabled={!field.accept}
                  onChange={(e) =>
                    update(
                      (s) => void (s.profile[f.key].value = e.target.value)
                    )
                  }
                />
              )}
              {current && !same(current, field.value) ? (
                <p className="text-xs text-muted-foreground">
                  Currently: {current}
                </p>
              ) : null}
              <Issues issues={issueFor(`profile.${f.key}`)} />
            </div>
          )
        })}
        {state.skills.length > 0 ? (
          <div className="grid gap-2">
            <Label>Skills (click to include or leave out)</Label>
            <div className="flex flex-wrap gap-1.5">
              {state.skills.map((skill, i) => (
                <button
                  key={skill.name}
                  type="button"
                  aria-pressed={skill.accept}
                  onClick={() =>
                    update(
                      (s) => void (s.skills[i].accept = !s.skills[i].accept)
                    )
                  }
                >
                  <Badge variant={skill.accept ? "default" : "outline"}>
                    {skill.name}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <Separator className="my-10" />
      <EntryList
        title="Experience"
        name="positions"
        fields={POSITION_FIELDS}
        entries={state.positions}
        issueFor={issueFor}
        onChange={(fn) => update((s) => fn(s.positions))}
        extra={(entry, i) => (
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor={`positions-${i}-description`}>Description</Label>
            <Textarea
              id={`positions-${i}-description`}
              rows={3}
              value={entry.values.description}
              disabled={!entry.accept}
              onChange={(e) =>
                update(
                  (s) =>
                    void (s.positions[i].values.description = e.target.value)
                )
              }
            />
          </div>
        )}
      />

      <Separator className="my-10" />
      <EntryList
        title="Education"
        name="education"
        fields={EDUCATION_FIELDS}
        entries={state.education}
        issueFor={issueFor}
        onChange={(fn) => update((s) => fn(s.education))}
      />

      <Separator className="my-10" />
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} disabled={busy !== null || acceptedCount === 0}>
          {busy === "save"
            ? "Saving…"
            : `Save ${acceptedCount} item${acceptedCount === 1 ? "" : "s"} to my repo`}
        </Button>
        <Button variant="outline" onClick={discard} disabled={busy !== null}>
          Discard
        </Button>
        <Link
          to="/profile/edit"
          className="ml-auto text-sm text-muted-foreground hover:underline"
        >
          Back to editor
        </Link>
      </div>
    </div>
  )
}

function EntryList({
  title,
  name,
  fields,
  entries,
  issueFor,
  onChange,
  extra,
}: {
  title: string
  name: "positions" | "education"
  fields: ReadonlyArray<{ key: string; label: string; required?: boolean }>
  entries: Array<Entry>
  issueFor: (path: string) => Array<Issue>
  onChange: (fn: (entries: Array<Entry>) => void) => void
  extra?: (entry: Entry, i: number) => React.ReactNode
}) {
  return (
    <section>
      <h2 className="font-medium">{title}</h2>
      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          None found in the resume.
        </p>
      ) : null}
      <ul className="mt-3 grid gap-3">
        {entries.map((entry, i) => {
          const missing = fields.filter(
            (f) => f.required && !entry.values[f.key]
          )
          return (
            <li
              key={i}
              className={`rounded-md border p-4 ${entry.accept ? "" : "opacity-60"}`}
            >
              <div className="flex items-center gap-2">
                <Label className="font-medium">
                  <Checkbox
                    checked={entry.accept}
                    onCheckedChange={(v) =>
                      onChange((list) => void (list[i].accept = v))
                    }
                  />
                  {entry.values.title || entry.values.school || "Untitled"}
                </Label>
                {entry.accept && missing.length > 0 ? (
                  <Badge variant="destructive">
                    needs{" "}
                    {missing
                      .map((f) => f.label.split(" ")[0].toLowerCase())
                      .join(", ")}
                  </Badge>
                ) : null}
              </div>
              {entry.accept ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {fields.map((f) => (
                    <div key={f.key} className="grid gap-1.5">
                      <Label
                        htmlFor={`${name}-${i}-${f.key}`}
                        className="text-xs"
                      >
                        {f.label}
                      </Label>
                      <Input
                        id={`${name}-${i}-${f.key}`}
                        value={entry.values[f.key]}
                        onChange={(e) =>
                          onChange(
                            (list) =>
                              void (list[i].values[f.key] = e.target.value)
                          )
                        }
                      />
                    </div>
                  ))}
                  {extra?.(entry, i)}
                  <div className="sm:col-span-2">
                    <Issues issues={issueFor(`${name}.${i}`)} />
                  </div>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Issues({ issues }: { issues: Array<Issue> }) {
  if (issues.length === 0) return null
  return (
    <ul className="text-xs text-destructive">
      {issues.map((i) => (
        <li key={i.path + i.message}>
          {i.path.split(".").at(-1)}: {i.message}
        </li>
      ))}
    </ul>
  )
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive">
      {children}
    </p>
  )
}
