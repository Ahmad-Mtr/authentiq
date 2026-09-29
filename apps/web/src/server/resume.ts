import type { Agent } from "@atproto/api"
import { sh } from "@workspace/lexicons"
import { z } from "zod"
import { ApiError, appViewError, callAppView } from "./appview.ts"
import {
  buildEducationRecord,
  buildPositionRecord,
  buildProfileRecord,
  educationInput,
  optionalText,
  positionInput,
} from "./records.ts"

/**
 * Resume import, BFF side (phase 4).
 *
 *   browser ──file──▶ /api/resume/upload ──service auth──▶ AppView uploadResume
 *   review page ◀── draft                                   (never the PDS)
 *   browser ──confirmed entries──▶ /api/resume/confirm ──applyWrites──▶ user's PDS
 *
 * Calls to the AppView go through ./appview.ts (service auth). The resume
 * never goes near `uploadBlob`: repo blobs are public (ADR 0001).
 */

const RESUME = sh.authentiq.resume
const PROFILE = sh.authentiq.actor.profile
const POSITION = sh.authentiq.actor.position
const EDUCATION = sh.authentiq.actor.education

export const MAX_RESUME_BYTES = 5 * 1024 * 1024

export type DraftView = sh.authentiq.resume.defs.DraftView

/** Sends the file to the AppView for parsing. The BFF keeps no copy. */
export async function uploadResume(
  agent: Agent,
  bytes: Uint8Array,
  contentType: string
): Promise<DraftView> {
  const res = await callAppView(agent, RESUME.uploadResume.$lxm, {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Uint8Array(bytes),
  })
  if (!res.ok) throw await appViewError(res)
  return RESUME.defs.draftView.parse(await res.json())
}

export async function fetchDraft(
  agent: Agent,
  id: string
): Promise<DraftView | null> {
  const res = await callAppView(agent, RESUME.getDraft.$lxm, { query: { id } })
  if (res.status === 400) return null
  if (!res.ok) throw await appViewError(res)
  return RESUME.defs.draftView.parse(await res.json())
}

export async function discardDraft(agent: Agent, id: string) {
  const res = await callAppView(agent, RESUME.deleteDraft.$lxm, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) throw await appViewError(res)
  return ((await res.json()) as { deleted: boolean }).deleted
}

/**
 * What the review step sends back: only the fields and entries the user
 * accepted, as they edited them. Nothing here comes from the draft on the
 * server; the draft id only proves there is a review in progress.
 */
export const confirmInput = z.object({
  draftId: z.string().min(1).max(64),
  profile: z
    .object({
      displayName: z.string().trim().min(1).max(64).optional(),
      headline: optionalText(120),
      about: optionalText(2000),
      location: optionalText(100),
      skills: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
    })
    .optional(),
  positions: z.array(positionInput).max(30).default([]),
  education: z.array(educationInput).max(15).default([]),
})
export type ConfirmInput = z.input<typeof confirmInput>

/**
 * Writes exactly the confirmed entries to the user's repo in one commit
 * (`applyWrites`), then deletes the draft. Every record is built first, so
 * one invalid entry means nothing is written.
 */
export async function confirmResume(agent: Agent, raw: unknown) {
  const parsed = confirmInput.safeParse(raw)
  if (!parsed.success) {
    throw new ApiError(
      400,
      "InvalidEntries",
      "Some entries need fixing",
      parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }))
    )
  }
  const input = parsed.data
  const did = agent.assertDid

  if (!(await fetchDraft(agent, input.draftId))) {
    throw new ApiError(
      410,
      "DraftNotFound",
      "This import has expired. Upload the resume again."
    )
  }

  type Write = NonNullable<
    Parameters<Agent["com"]["atproto"]["repo"]["applyWrites"]>[0]
  >["writes"][number]
  const writes: Array<Write> = []

  // The profile is one record. Accepted fields replace the current values;
  // fields the user rejected keep whatever the profile already had.
  const profile: NonNullable<typeof input.profile> = input.profile ?? {
    headline: undefined,
    about: undefined,
    location: undefined,
  }
  const accepted = Object.fromEntries(
    Object.entries(profile).filter(([, v]) => v !== undefined)
  )
  if (Object.keys(accepted).length > 0) {
    const current = await agent.com.atproto.repo
      .getRecord({ repo: did, collection: PROFILE.$nsid, rkey: "self" })
      .then((r) => r.data.value)
      .catch(() => undefined)
    const existing = PROFILE.$matches(current) ? current : undefined
    const skills = [...(existing?.skills ?? [])]
    for (const s of profile.skills ?? []) {
      if (!skills.some((k) => k.toLowerCase() === s.toLowerCase()))
        skills.push(s)
    }
    const displayName = profile.displayName ?? existing?.displayName
    if (!displayName) {
      throw new ApiError(400, "InvalidEntries", "A display name is required", [
        { path: "profile.displayName", message: "Required for a new profile" },
      ])
    }
    const { $type: _, ...rest } = existing ?? {}
    writes.push({
      $type: existing
        ? "com.atproto.repo.applyWrites#update"
        : "com.atproto.repo.applyWrites#create",
      collection: PROFILE.$nsid,
      rkey: "self",
      value: buildProfileRecord({
        ...rest,
        ...accepted,
        displayName,
        skills: skills.length > 0 ? skills.slice(0, 50) : undefined,
      }),
    })
  }
  for (const p of input.positions) {
    writes.push({
      $type: "com.atproto.repo.applyWrites#create",
      collection: POSITION.$nsid,
      value: buildPositionRecord(p),
    })
  }
  for (const e of input.education) {
    writes.push({
      $type: "com.atproto.repo.applyWrites#create",
      collection: EDUCATION.$nsid,
      value: buildEducationRecord(e),
    })
  }

  let uris: Array<string> = []
  if (writes.length > 0) {
    const { data } = await agent.com.atproto.repo.applyWrites({
      repo: did,
      writes,
    })
    uris = (data.results ?? []).flatMap((r) => ("uri" in r ? [r.uri] : []))
  }
  await discardDraft(agent, input.draftId)
  return { written: writes.length, uris }
}
