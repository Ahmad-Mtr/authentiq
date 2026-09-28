import { createFileRoute, notFound } from "@tanstack/react-router"
import { getProfileView } from "../server/profile.ts"

export const Route = createFileRoute("/p/$actor")({
  loader: async ({ params }) => {
    const profile = await getProfileView({ data: { actor: params.actor } })
    if (!profile) throw notFound()
    return profile
  },
  component: ProfilePage,
})

function ProfilePage() {
  const profile = Route.useLoaderData()

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold">
          {profile.displayName ?? profile.handle}
        </h1>
        <p className="text-muted-foreground text-sm">
          @{profile.handle}
          {profile.location ? ` · ${profile.location}` : ""}
        </p>
        {profile.headline ? <p className="mt-2">{profile.headline}</p> : null}
        {profile.openToWork ? (
          <span className="mt-3 inline-block rounded-full border px-2 py-0.5 text-xs">
            Open to work
          </span>
        ) : null}
      </header>

      {profile.about ? (
        <p className="mt-6 text-sm leading-relaxed whitespace-pre-line">
          {profile.about}
        </p>
      ) : null}

      {profile.skills?.length ? (
        <ul className="mt-6 flex flex-wrap gap-2">
          {profile.skills.map((skill) => (
            <li key={skill} className="bg-muted rounded-md px-2 py-1 text-xs">
              {skill}
            </li>
          ))}
        </ul>
      ) : null}

      {profile.positions?.length ? (
        <section className="mt-10">
          <h2 className="font-medium">Experience</h2>
          <ul className="mt-3 grid gap-4">
            {profile.positions.map((p) => (
              <li key={p.uri}>
                <p className="text-sm font-medium">
                  {p.title} · {p.organization}
                </p>
                <p className="text-muted-foreground text-xs">
                  {p.startDate} – {p.endDate ?? "present"}
                  {p.locationType ? ` · ${p.locationType}` : ""}
                </p>
                {p.description ? (
                  <p className="mt-1 text-sm leading-relaxed">{p.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {profile.education?.length ? (
        <section className="mt-10">
          <h2 className="font-medium">Education</h2>
          <ul className="mt-3 grid gap-3">
            {profile.education.map((e) => (
              <li key={e.uri} className="text-sm">
                <span className="font-medium">{e.school}</span>
                {e.degree ? ` · ${e.degree}` : ""}
                {e.fieldOfStudy ? `, ${e.fieldOfStudy}` : ""}
                <span className="text-muted-foreground block text-xs">
                  {e.startDate} – {e.endDate ?? "present"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-muted-foreground mt-12 text-xs">
        Served by the AppView · <code>{profile.did}</code>
      </p>
    </main>
  )
}
