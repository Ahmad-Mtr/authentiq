import { Elysia, status, t } from "elysia"
import { desc, eq } from "drizzle-orm"
import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { db } from "../db.ts"

/**
 * sh.authentiq.actor.getProfile
 *
 * Reads the firehose-backed index (phase 3). Only records that passed lexicon
 * and business-rule validation at index time are here, so nothing is
 * re-checked on the read path. Deactivated and taken-down actors are hidden.
 *
 * `loadProfileView` is the query itself (null for an unknown or hidden actor),
 * shared by the XRPC route below and the recruiting agent's tools.
 */
export async function loadProfileView(
  actorId: string
): Promise<sh.authentiq.actor.defs.ProfileViewDetailed | null> {
  const identifier = actorId.toLowerCase()
  const [actor] = await db
    .select()
    .from(schema.actor)
    .where(
      identifier.startsWith("did:")
        ? eq(schema.actor.did, actorId)
        : eq(schema.actor.handle, identifier)
    )
  if (!actor?.active) return null

  const [[profile], positions, education] = await Promise.all([
    db.select().from(schema.profile).where(eq(schema.profile.did, actor.did)),
    db.select().from(schema.position).where(eq(schema.position.did, actor.did)),
    db
      .select()
      .from(schema.education)
      .where(eq(schema.education.did, actor.did))
      // TIDs sort by creation time: newest entry first.
      .orderBy(desc(schema.education.uri)),
  ])

  // Built as a plain object, then parsed through the generated view schema:
  // that validates the branded formats (did, handle, at-uri, datetime) at
  // runtime instead of us asserting them.
  return sh.authentiq.actor.defs.profileViewDetailed.parse({
    did: actor.did,
    handle: actor.handle ?? "handle.invalid",
    displayName: profile?.displayName,
    headline: profile?.headline ?? undefined,
    about: profile?.about ?? undefined,
    location: profile?.location ?? undefined,
    openToWork: profile?.openToWork ?? undefined,
    skills: profile?.skills ?? undefined,
    positions: positions
      .map((p) => ({
        uri: p.uri,
        cid: p.cid,
        title: p.title,
        organization: p.organization,
        employmentType: p.employmentType ?? undefined,
        locationType: p.locationType ?? undefined,
        location: p.location ?? undefined,
        startDate: p.startDate,
        endDate: p.endDate ?? undefined,
        description: p.description ?? undefined,
        skills: p.skills ?? undefined,
      }))
      .sort((a, b) => (a.startDate < b.startDate ? 1 : -1)),
    education: education.map((e) => ({
      uri: e.uri,
      cid: e.cid,
      school: e.school,
      degree: e.degree ?? undefined,
      fieldOfStudy: e.fieldOfStudy ?? undefined,
      startDate: e.startDate ?? undefined,
      endDate: e.endDate ?? undefined,
      description: e.description ?? undefined,
    })),
    indexedAt: (profile?.indexedAt ?? actor.indexedAt).toISOString(),
  })
}

export const getProfile = new Elysia().get(
  "/xrpc/sh.authentiq.actor.getProfile",
  async ({ query }) =>
    (await loadProfileView(query.actor)) ??
    status(400, {
      error: "ActorNotFound",
      message: `Unknown actor: ${query.actor}`,
    }),
  { query: t.Object({ actor: t.String() }) }
)
