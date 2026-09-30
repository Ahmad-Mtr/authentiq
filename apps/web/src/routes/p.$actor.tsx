import { createFileRoute, getRouteApi, notFound, useRouter } from "@tanstack/react-router"
import { Separator } from "@workspace/ui/components/separator"
import { Composer } from "../components/social/composer.tsx"
import { FollowButton } from "../components/social/follow-button.tsx"
import { PostCard } from "../components/social/post-card.tsx"
import { getProfileView } from "../server/profile.ts"
import { getAuthorFeed } from "../server/social-fns.ts"

export const Route = createFileRoute("/p/$actor")({
  loader: async ({ params }) => {
    const [profile, feed] = await Promise.all([
      getProfileView({ data: { actor: params.actor } }),
      getAuthorFeed({ data: { actor: params.actor } }),
    ])
    if (!profile) throw notFound()
    return { profile, feed }
  },
  component: ProfilePage,
})

const root = getRouteApi("__root__")

function ProfilePage() {
  const { profile, feed } = Route.useLoaderData()
  const viewer = root.useLoaderData()?.did ?? null
  const router = useRouter()
  const isSelf = viewer === profile.did

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
        {viewer && !isSelf ? (
          <div className="mt-4">
            <FollowButton
              key={profile.did}
              subject={profile.did}
              following={profile.viewer?.following}
            />
          </div>
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
                {/* Education dates are optional; with none there is no range to show. */}
                {e.startDate || e.endDate ? (
                  <span className="text-muted-foreground block text-xs">
                    {e.startDate ?? "?"} – {e.endDate ?? "present"}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Separator className="my-10" />

      <section>
        <h2 className="font-medium">Posts</h2>
        {isSelf ? (
          <div className="mt-4">
            <Composer onPosted={() => router.invalidate()} />
          </div>
        ) : null}
        <div className="mt-4 grid gap-3">
          {feed.map((item) => (
            <PostCard
              key={item.post.uri}
              post={item.post}
              replyTo={item.replyTo}
              viewer={viewer}
            />
          ))}
          {feed.length === 0 ? (
            <p className="text-muted-foreground text-sm">No posts yet.</p>
          ) : null}
        </div>
      </section>

      <p className="text-muted-foreground mt-12 text-xs">
        Served by the AppView · <code>{profile.did}</code>
      </p>
    </main>
  )
}
