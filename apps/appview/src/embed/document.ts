import { createHash } from "node:crypto"
import { redactDocument } from "./protected.ts"

/**
 * The canonical profile document: what talent search embeds and full-text
 * indexes for an actor. Pure, so it is unit-tested (document.test.ts) and
 * the same input always gives the same text, hash and vector.
 *
 * In, all from public records: headline, about, skills (profile and
 * per-position), and for each position its title, organization, whether it is
 * current, employment and location type, description and skills; for each
 * education entry the degree and field of study.
 *
 * Out, because they identify a person or stand in for a protected attribute:
 *   - name, handle, avatar: identity, and names proxy gender and ethnicity;
 *   - every date and graduation year, plus years and ages in free text: age;
 *   - school names: can proxy religion, ethnicity or gender (seminaries,
 *     HBCUs, women's colleges). Degree and field stay;
 *   - pronoun sets and the protected terms in ./protected.ts;
 *   - location and openToWork: they are explicit filters on searchTalent,
 *     so they narrow results without skewing similarity. Location also
 *     proxies national origin.
 *
 * Positions are ordered newest first (dates decide the order, then are
 * dropped), so the current role leads.
 */

/** Bump when the builder's output changes, so every document is re-embedded. */
export const DOCUMENT_VERSION = 1

/** mistral-embed takes 8k tokens; resumes rarely need a quarter of that. */
const MAX_CHARS = 6000

export type ProfileSource = {
  profile: {
    headline?: string | null
    about?: string | null
    skills?: Array<string> | null
  } | null
  positions: Array<{
    title: string
    organization: string
    employmentType?: string | null
    locationType?: string | null
    startDate: string
    endDate?: string | null
    description?: string | null
    skills?: Array<string> | null
  }>
  education: Array<{
    degree?: string | null
    fieldOfStudy?: string | null
    startDate?: string | null
  }>
}

/** The document, or null when there is nothing to search (no profile record). */
export function buildProfileDocument(src: ProfileSource): string | null {
  if (!src.profile) return null
  const clean = (s?: string | null) => (s ? redactDocument(s) : "")
  const lines: Array<string> = []

  const headline = clean(src.profile.headline)
  if (headline) lines.push(`Headline: ${headline}`)
  const about = clean(src.profile.about)
  if (about) lines.push(`About: ${about}`)

  const skills = new Map<string, string>()
  for (const s of [
    ...(src.profile.skills ?? []),
    ...src.positions.flatMap((p) => p.skills ?? []),
  ]) {
    const v = clean(s)
    if (v && !skills.has(v.toLowerCase())) skills.set(v.toLowerCase(), v)
  }
  if (skills.size) lines.push(`Skills: ${[...skills.values()].join(", ")}`)

  const positions = [...src.positions].sort((a, b) =>
    a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0
  )
  if (positions.length) {
    lines.push("Experience:")
    for (const p of positions) {
      const traits = [
        p.endDate ? "" : "current",
        clean(p.employmentType),
        clean(p.locationType),
      ].filter(Boolean)
      const head = `${clean(p.title)} at ${clean(p.organization)}${traits.length ? ` (${traits.join(", ")})` : ""}`
      const body = clean(p.description).replace(/\n+/g, " ")
      lines.push(`- ${head}${body ? `. ${body}` : ""}`)
    }
  }

  const education = [...src.education]
    .sort((a, b) => ((a.startDate ?? "") < (b.startDate ?? "") ? 1 : -1))
    .map((e) =>
      [clean(e.degree), clean(e.fieldOfStudy)].filter(Boolean).join(" in ")
    )
    .filter(Boolean)
  if (education.length) {
    lines.push("Education:")
    for (const e of education) lines.push(`- ${e}`)
  }

  const doc = lines.join("\n")
  return doc.length > MAX_CHARS ? doc.slice(0, MAX_CHARS) : doc
}

/** Changes when the document, the builder or the model does. */
export function hashDocument(model: string, document: string) {
  return createHash("sha256")
    .update(`${DOCUMENT_VERSION}\n${model}\n${document}`)
    .digest("hex")
}
