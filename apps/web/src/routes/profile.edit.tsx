import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Separator } from "@workspace/ui/components/separator"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import { useState } from "react"
import {
  addEducation,
  addPosition,
  deleteRecord,
  getMyRecords,
  saveProfile,
} from "../server/profile.ts"

export const Route = createFileRoute("/profile/edit")({
  loader: async () => {
    const records = await getMyRecords()
    if (!records) throw redirect({ to: "/login" })
    return records
  },
  component: EditProfile,
})

function EditProfile() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setBusy(null)
    }
  }

  const profile = data.profile

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold">Edit profile</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Every change here is written as a record in your repo at{" "}
        <code className="text-xs">{data.did}</code>.{" "}
        <Link to="/profile/import" search={{ draft: undefined }} className="underline">
          Import from a resume
        </Link>
      </p>

      {error ? (
        <p className="border-destructive/50 text-destructive mt-4 rounded-md border px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      <form
        className="mt-8 grid gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          const form = new FormData(e.currentTarget)
          void run("profile", () =>
            saveProfile({
              data: {
                displayName: String(form.get("displayName") ?? ""),
                headline: String(form.get("headline") ?? ""),
                about: String(form.get("about") ?? ""),
                location: String(form.get("location") ?? ""),
                openToWork: form.get("openToWork") === "on",
                skills: String(form.get("skills") ?? ""),
              },
            })
          )
        }}
      >
        <Row label="Display name" name="displayName" defaultValue={profile?.displayName} required />
        <Row label="Headline" name="headline" defaultValue={profile?.headline} />
        <div className="grid gap-2">
          <Label htmlFor="about">About</Label>
          <Textarea id="about" name="about" rows={4} defaultValue={profile?.about} />
        </div>
        <Row label="Location" name="location" defaultValue={profile?.location} />
        <Row
          label="Skills (comma separated)"
          name="skills"
          defaultValue={profile?.skills.join(", ")}
        />
        <div className="flex items-center gap-3">
          <Switch id="openToWork" name="openToWork" defaultChecked={profile?.openToWork} />
          <Label htmlFor="openToWork">
            Open to work — appear in talent search
          </Label>
        </div>
        <Button type="submit" disabled={busy === "profile"} className="justify-self-start">
          {busy === "profile" ? "Saving…" : "Save profile"}
        </Button>
      </form>

      <Separator className="my-10" />

      <section>
        <h2 className="font-medium">Experience</h2>
        <ul className="mt-3 grid gap-2">
          {data.positions.map((p) => (
            <li
              key={p.uri}
              className="flex items-start justify-between rounded-md border px-3 py-2 text-sm"
            >
              <span>
                <strong className="font-medium">{p.title}</strong> · {p.organization}
                <span className="text-muted-foreground block text-xs">
                  {p.startDate} – {p.endDate ?? "present"}
                </span>
              </span>
              <button
                className="text-muted-foreground text-xs hover:underline"
                onClick={() => run(p.uri, () => deleteRecord({ data: { uri: p.uri } }))}
              >
                Delete
              </button>
            </li>
          ))}
          {data.positions.length === 0 ? (
            <li className="text-muted-foreground text-sm">Nothing yet.</li>
          ) : null}
        </ul>

        <form
          className="mt-4 grid gap-3 rounded-md border p-4"
          onSubmit={(e) => {
            e.preventDefault()
            const form = new FormData(e.currentTarget)
            const el = e.currentTarget
            void run("position", async () => {
              await addPosition({
                data: {
                  title: String(form.get("title") ?? ""),
                  organization: String(form.get("organization") ?? ""),
                  employmentType: String(form.get("employmentType") ?? ""),
                  locationType: String(form.get("locationType") ?? ""),
                  location: String(form.get("location") ?? ""),
                  startDate: String(form.get("startDate") ?? ""),
                  endDate: String(form.get("endDate") ?? ""),
                  description: String(form.get("description") ?? ""),
                  skills: String(form.get("skills") ?? ""),
                },
              })
              el.reset()
            })
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Row label="Title" name="title" required />
            <Row label="Organization" name="organization" required />
            <Row label="Start (YYYY-MM)" name="startDate" placeholder="2024-06" required />
            <Row label="End (blank = current)" name="endDate" placeholder="2025-03" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" name="description" rows={3} />
          </div>
          <Button type="submit" disabled={busy === "position"} className="justify-self-start">
            Add position
          </Button>
        </form>
      </section>

      <Separator className="my-10" />

      <section>
        <h2 className="font-medium">Education</h2>
        <ul className="mt-3 grid gap-2">
          {data.education.map((e) => (
            <li
              key={e.uri}
              className="flex items-start justify-between rounded-md border px-3 py-2 text-sm"
            >
              <span>
                <strong className="font-medium">{e.school}</strong>
                {e.degree ? ` · ${e.degree}` : ""}
              </span>
              <button
                className="text-muted-foreground text-xs hover:underline"
                onClick={() => run(e.uri, () => deleteRecord({ data: { uri: e.uri } }))}
              >
                Delete
              </button>
            </li>
          ))}
          {data.education.length === 0 ? (
            <li className="text-muted-foreground text-sm">Nothing yet.</li>
          ) : null}
        </ul>

        <form
          className="mt-4 grid gap-3 rounded-md border p-4"
          onSubmit={(e) => {
            e.preventDefault()
            const form = new FormData(e.currentTarget)
            const el = e.currentTarget
            void run("education", async () => {
              await addEducation({
                data: {
                  school: String(form.get("school") ?? ""),
                  degree: String(form.get("degree") ?? ""),
                  fieldOfStudy: String(form.get("fieldOfStudy") ?? ""),
                  startDate: String(form.get("startDate") ?? ""),
                  endDate: String(form.get("endDate") ?? ""),
                },
              })
              el.reset()
            })
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Row label="School" name="school" required />
            <Row label="Degree" name="degree" />
            <Row label="Field of study" name="fieldOfStudy" />
            <Row label="Start (YYYY)" name="startDate" placeholder="2018" />
          </div>
          <Button type="submit" disabled={busy === "education"} className="justify-self-start">
            Add education
          </Button>
        </form>
      </section>
    </main>
  )
}

function Row({
  label,
  name,
  defaultValue,
  placeholder,
  required,
}: {
  label: string
  name: string
  defaultValue?: string
  placeholder?: string
  required?: boolean
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
      />
    </div>
  )
}
