import { createHash } from "node:crypto"
import { redactDocument, redactJobText } from "@workspace/rules/protected"

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
 *   - pronoun sets and the protected terms in @workspace/rules/protected;
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

/**
 * Changes when the document, the builder or the model does. Each subject kind
 * has its own builder version, so changing the job builder never re-embeds
 * profiles.
 */
export function hashDocument(
  model: string,
  document: string,
  version: number = DOCUMENT_VERSION
) {
  return createHash("sha256")
    .update(`${version}\n${model}\n${document}`)
    .digest("hex")
}

// --- Job postings (phase 7) ---------------------------------------------------

/**
 * The canonical job document: what similar candidates and match scores embed
 * for a posting. Pure, like the profile builder, and tested alongside it.
 *
 * In: title, seniority (read from the title), employment and location type,
 * skills, and the description. That is the work itself, which is what a
 * profile document describes too.
 *
 * Out:
 *   - organization: an employer's name can stand in for religion or origin,
 *     and it is not the work;
 *   - location and salary: filters on the board, not similarity;
 *   - close date, apply link, author: not about the work;
 *   - protected wording (`redactJobText`): the profile list plus job-ad
 *     phrases that code for age or national origin ("young, energetic team",
 *     "native English speaker", "recent graduates"). A posting cannot steer
 *     matching with them.
 */
export const JOB_DOCUMENT_VERSION = 1

export type JobSource = {
  title: string
  description?: string | null
  employmentType?: string | null
  locationType?: string | null
  skills?: Array<string> | null
}

/**
 * Seniority as the title states it, in the talent corpus's vocabulary, or
 * undefined when the title does not say. Only titles: years-of-experience
 * wording stays in the description, where the model reads it in context.
 */
export function seniorityOf(title: string): string | undefined {
  const t = title.toLowerCase()
  const has = (re: RegExp) => re.test(t)
  if (has(/\bintern(ship)?\b|\btrainee\b|\bapprentice\b/)) return "internship"
  if (has(/\b(junior|jr\.?|entry[- ]level|graduate)\b/)) return "junior"
  if (has(/\b(staff|principal|lead|head of|director|vp)\b/)) return "lead"
  if (has(/\b(senior|sr\.?)\b/)) return "senior"
  if (has(/\b(mid[- ]level|intermediate)\b/)) return "mid"
  return undefined
}

export function buildJobDocument(src: JobSource): string {
  const lines: Array<string> = []
  const title = redactJobText(src.title)
  if (title) lines.push(`Role: ${title}`)
  // From the redacted title, so "Recent Graduate Engineer" does not come
  // back in as a seniority.
  const seniority = seniorityOf(title)
  if (seniority) lines.push(`Seniority: ${seniority}`)
  const traits = [src.employmentType, src.locationType]
    .map((t) => (t ? redactJobText(t) : ""))
    .filter(Boolean)
  if (traits.length) lines.push(`Type: ${traits.join(", ")}`)
  const skills = new Map<string, string>()
  for (const s of src.skills ?? []) {
    const v = redactJobText(s)
    if (v && !skills.has(v.toLowerCase())) skills.set(v.toLowerCase(), v)
  }
  if (skills.size) lines.push(`Skills: ${[...skills.values()].join(", ")}`)
  const description = src.description ? redactJobText(src.description) : ""
  if (description)
    lines.push(`Description: ${description.replace(/\n+/g, " ")}`)
  const doc = lines.join("\n")
  return doc.length > MAX_CHARS ? doc.slice(0, MAX_CHARS) : doc
}
