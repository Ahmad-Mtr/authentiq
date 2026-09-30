/**
 * Generates the demo cast with Mistral, once, into infra/fixtures/demo/.
 * The output is committed; `bun run seed:demo` replays it through the PDS,
 * so re-seeding is deterministic and costs nothing. Re-running this script
 * produces different text (temperature > 0): that is a new fixture, to be
 * reviewed and committed like any other change.
 *
 * Who is in the cast is decided in code, not by the model. A seeded plan
 * gives each person a field, a seniority, a gender, a region their name
 * comes from and a city they live in, each drawn so that none of them
 * predicts another (see `plan`). The model writes the words: names typical
 * of the region, headlines, careers at invented employers, community
 * threads and job postings. Why the plan exists is in docs/evals.md: a
 * first, unplanned pass (`--naive`) skewed.
 *
 * Everything the model returns is checked before it is kept: the lexicon
 * ($parse), the indexer's rules, the salary-transparency rules, a list of
 * real organisation names that must not appear, and dates not after the
 * generation month. Failures are logged and dropped, never repaired by hand.
 *
 *   bun run fixtures:demo                   # the planned cast → infra/fixtures/demo/
 *   bun run fixtures:demo -- --naive --out <dir>   # the unplanned audit pass
 *   bun run fixtures:demo -- --audit        # re-print the audit of the committed fixtures
 *
 * Needs MISTRAL_API_KEY, read from apps/appview/.env.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { costOf, getMistral, mistralRetries } from "@workspace/ai"
import { sh } from "@workspace/lexicons"
import { checkPosting } from "@workspace/rules/posting"
import { findProtectedTerms } from "@workspace/rules/protected"
import { z } from "zod"
import {
  FIELDS,
  REAL_ORGS,
  REGIONS,
  SEED,
  SENIORITIES,
  plan,
  prng,
} from "./lib/demo-plan.ts"
import type { FieldKey, Slot } from "./lib/demo-plan.ts"
import {
  checkCommunity,
  checkDateRange,
  checkPostText,
} from "../../apps/appview/src/indexer/rules.ts"

const root = join(import.meta.dir, "..", "..")
const OUT = join(root, "infra", "fixtures", "demo")

/** Pinned, like every model in packages/ai. */
export const DEMO_MODEL = "mistral-medium-2604"
const TEMPERATURE = 0.7
/** The month the cast is written in: no date may be later. */
const THIS_MONTH = "2026-09"

// --- what the model returns -------------------------------------------------------

const EMPLOYMENT = ["full-time", "part-time", "contract", "internship", "freelance"] as const
const WORKPLACE = ["onsite", "hybrid", "remote"] as const

const NameOut = z.object({
  displayName: z.string().describe("Full name: given name and family name."),
})

/**
 * The profile is written without the person's name or gender. The model
 * never learns the gender it is writing for, so the wording cannot follow
 * it. (The first planned run told it, and "caring", "empathetic" and
 * "nurturing" went to 4 of 23 women and 0 of 24 men.)
 */
const ProfileOut = z.object({
  headline: z.string().describe("A professional headline, at most 100 characters."),
  about: z.string().describe("First person, 2 to 4 sentences, about the work only."),
  skills: z.array(z.string()).describe("5 to 10 skills, tools or methods."),
  positions: z
    .array(
      z.object({
        title: z.string(),
        organization: z.string().describe("An invented employer that does not exist."),
        employmentType: z.enum(EMPLOYMENT).nullable(),
        locationType: z.enum(WORKPLACE).nullable(),
        location: z.string().nullable().describe("City, country code"),
        startDate: z.string().describe('"YYYY-MM"'),
        endDate: z.string().nullable().describe('"YYYY-MM", or null for the current role'),
        description: z.string().describe("1 to 2 sentences on what they did there."),
      })
    )
    .describe("2 to 4 roles, newest first. Exactly one current role (endDate null)."),
  education: z
    .array(
      z.object({
        school: z.string().describe("An invented school named after an invented place."),
        degree: z.string(),
        fieldOfStudy: z.string(),
        startDate: z.string().describe('"YYYY"'),
        endDate: z.string().describe('"YYYY"'),
      })
    )
    .describe("1 or 2 entries."),
})
const PersonOut = ProfileOut.extend(NameOut.shape)
type Person = z.infer<typeof PersonOut>

const NaivePersonOut = PersonOut.extend({
  location: z.string(),
  openToWork: z.boolean(),
  audit: z.object({
    gender: z.enum(["woman", "man", "nonbinary"]).describe("The gender you imagined for this person."),
    nameOrigin: z.string().describe("The world region the name is most common in."),
    field: z.string().describe("Their professional field, in a few words."),
    seniority: z.enum(SENIORITIES),
  }),
})
const NaiveBatchOut = z.object({ people: z.array(NaivePersonOut) })

const CommunityOut = z.object({
  description: z.string().describe("One or two sentences: what the community is for."),
  rules: z.array(z.string()).describe("3 short rules."),
  threads: z
    .array(
      z.object({
        author: z.string().describe("Handle of the member who starts the thread."),
        text: z.string().describe("The opening post: 80 to 220 words, specific, first person."),
        replies: z.array(
          z.object({
            author: z.string().describe("Handle of whoever replies."),
            text: z.string().describe("20 to 120 words, a real answer to what it replies to."),
            replyTo: z.number().int().describe("0 = the opening post; n = the n-th reply above."),
          })
        ),
      })
    )
    .describe("4 threads."),
})

const PostingOut = z.object({
  title: z.string(),
  organization: z.string().describe("An invented employer that does not exist."),
  description: z.string().describe("80 to 160 words: the work, the team, what they need."),
  skills: z.array(z.string()).describe("4 to 7"),
  salaryMin: z.number().int(),
  salaryMax: z.number().int(),
  annualMinEquivalent: z.number().int().describe("salaryMin converted to a full-time year, for checking."),
})

// --- prompts (recorded verbatim in meta.json) -------------------------------------

export const SYSTEM_PROMPT = `You write realistic, entirely fictional material for the demo of a professional network.

Everything you write must be invented:
- People: invented people. Never a real, well-known person.
- Employers: invented organisation names that do not exist. Never a real company, brand, government body, hospital, school district or NGO. Plausible, specific and varied names, like a real small or mid-sized organisation might have; not generic tech words (Nexus, Nexora, Lumina, Luminary, Apex, Synergy).
- Schools: invented schools, named only after the invented place names you are given. Never a real university, and never a real place (in any language or transliteration) in a school's name.
Tools, methods and technologies (PostgreSQL, Figma, IFRS 16, Kubernetes, CPR) are fine: they are skills, not organisations.

Write about work: what people do, how, and what they have learned. Do not mention anyone's age, birth year, family, religion, ethnicity, nationality, health, disability, sexuality or gender. No links, no hashtags, no @mentions, no emoji.`

const namePrompt = (s: Slot, taken: Array<string>) => `Give one invented person's full name: ${REGIONS[s.region]!.names}, for a ${s.gender === "nonbinary" ? "non-binary person (a given name that is not strongly gendered suits)" : s.gender}. Vary your choices: avoid the most stereotypical names for the region.${taken.length ? ` These are taken, and so are their given names: ${taken.join(", ")}.` : ""}`

/** Invented, pronounceable place names from seeded syllables: schools must use them. */
function inventedPlaces(seed: number, n = 3) {
  const rand = prng(seed)
  const a = ["Or", "Tes", "Mal", "Ker", "Sab", "Vel", "Dun", "Ais", "Bra", "Cor", "Eld", "Fen", "Gal", "Hol", "Ish", "Jor", "Kal", "Lor", "Mer", "Nol", "Pel", "Quin", "Ros", "Sil", "Tal", "Ul", "Var", "Wen", "Yar", "Zel"]
  const b = ["an", "e", "i", "o", "u", "a", "ey", "ou", "ia"]
  const c = ["mere", "vik", "dale", "stan", "ford", "gard", "holm", "wick", "tor", "wen", "bury", "sund", "ria", "ona", "enne", "ara"]
  const pick = (xs: Array<string>) => xs[Math.floor(rand() * xs.length)]!
  return Array.from({ length: n }, () => `${pick(a)}${pick(b)}${pick(c)}`)
}

const personPrompt = (s: Slot) => `Write one person's profile. Their name is given elsewhere: do not write it.

- Invented place names for their schools (use one per school, as "University of X", "X Institute of Technology", "X College" and so on): ${inventedPlaces(SEED + s.index).join(", ")}
- Field: ${FIELDS[s.field]}
- Seniority: ${s.seniority} (junior: under 3 years of experience; mid: 3–6; senior: 6–12; lead: 10 or more and leads others)
- Lives in: ${s.location}
- ${s.openToWork ? "Open to new roles." : "Not looking for a new role."}
- Today is ${THIS_MONTH}. No date may be later than ${THIS_MONTH}.

Careers are consistent with the seniority: dates, titles and the number of roles. Employers are invented and differ from each other. Education fits the field.`

const naivePrompt = (n: number, taken: Array<string>) => `Create ${n} fictional professionals for the demo of a professional network, in any fields you like. Make the group diverse.${taken.length ? `\n\nThese names are taken, do not reuse them: ${taken.join(", ")}.` : ""}

For each, also fill "audit" honestly: the gender you imagined, the world region their name is most common in, their field in a few words, and their seniority. Today is ${THIS_MONTH}; no date may be later.`

// --- validation --------------------------------------------------------------------

const errors: Array<string> = []
const drop = (what: string, why: string) => {
  errors.push(`${what}: ${why}`)
  console.log(`  ✗ dropped ${what}: ${why}`)
}

function checkPerson(p: Person, label: string): boolean {
  const texts = [p.displayName, p.headline, p.about, ...p.positions.flatMap((x) => [x.organization, x.title, x.description]), ...p.education.map((e) => e.school)]
  const real = texts.join(" | ").match(REAL_ORGS)
  if (real) return (drop(label, `names a real organisation (“${real[0]}”)`), false)
  for (const x of p.positions) {
    const bad =
      checkDateRange(x.startDate, x.endDate ?? undefined) ??
      (x.startDate > THIS_MONTH || (x.endDate ?? "") > THIS_MONTH ? `a date after ${THIS_MONTH}` : undefined)
    if (bad) return (drop(label, `position “${x.title}”: ${bad}`), false)
  }
  for (const e of p.education) {
    const bad = checkDateRange(e.startDate, e.endDate) ?? (e.endDate > THIS_MONTH ? `a date after ${THIS_MONTH}` : undefined)
    if (bad) return (drop(label, `education “${e.school}”: ${bad}`), false)
  }
  if (p.positions.filter((x) => !x.endDate).length !== 1)
    return (drop(label, "not exactly one current role"), false)
  try {
    sh.authentiq.actor.profile.$parse({
      $type: sh.authentiq.actor.profile.$type,
      displayName: p.displayName,
      headline: p.headline,
      about: p.about,
      skills: p.skills,
      createdAt: new Date().toISOString(),
    })
    for (const x of p.positions)
      sh.authentiq.actor.position.$parse({ $type: sh.authentiq.actor.position.$type, ...positionRecord(x), createdAt: new Date().toISOString() })
    for (const e of p.education)
      sh.authentiq.actor.education.$parse({ $type: sh.authentiq.actor.education.$type, ...e, createdAt: new Date().toISOString() })
  } catch (err) {
    return (drop(label, `lexicon: ${(err as Error).message}`), false)
  }
  return true
}

export const positionRecord = (x: Person["positions"][number]) =>
  Object.fromEntries(
    Object.entries({
      title: x.title,
      organization: x.organization,
      employmentType: x.employmentType,
      locationType: x.locationType,
      location: x.location,
      startDate: x.startDate,
      endDate: x.endDate,
      description: x.description,
    }).filter(([, v]) => v !== null && v !== undefined && v !== "")
  )

// --- model calls ---------------------------------------------------------------------

for (const line of (await Bun.file(join(root, "apps/appview/.env")).text()).split("\n")) {
  const m = line.match(/^MISTRAL_API_KEY=(.+)$/)
  if (m && !process.env.MISTRAL_API_KEY) process.env.MISTRAL_API_KEY = m[1]!.trim()
}

const usage = { calls: 0, prompt: 0, completion: 0 }
async function ask<T extends z.ZodTypeAny>(schema: T, user: string, maxTokens = 3000): Promise<z.infer<T>> {
  for (let attempt = 1; ; attempt++) {
    const res = await getMistral().chat.parse(
      {
        model: DEMO_MODEL,
        temperature: TEMPERATURE,
        maxTokens,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        responseFormat: schema,
      },
      { timeoutMs: 180_000, ...mistralRetries(60_000) }
    )
    usage.calls++
    usage.prompt += res.usage.promptTokens ?? 0
    usage.completion += res.usage.completionTokens ?? 0
    const parsed = res.choices?.[0]?.message?.parsed
    if (parsed) return parsed as z.infer<T>
    console.log(`  · no schema-valid answer (finish reason ${res.choices?.[0]?.finishReason}), attempt ${attempt}`)
    if (attempt >= 3) throw new Error(`no schema-valid answer after 3 attempts`)
  }
}

/** At most `n` calls in flight. */
async function pool<T, R>(items: Array<T>, n: number, fn: (item: T) => Promise<R>) {
  const out: Array<R> = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!)
    })
  )
  return out
}

const slug = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)

// --- audit ---------------------------------------------------------------------------

/** Words that give a stereotype away in otherwise neutral text. */
const GENDERED = /\b(he|him|his|she|her|hers|mother|father|mom|dad|wife|husband|girl|boy|lady|gentleman|chairman|chairwoman|salesman|saleswoman|manpower)\b/i
const TRAITS = {
  nurturing: /\b(caring|nurtur\w*|empath\w*|compassion\w*|warm|gentle|supportive)\b/i,
  assertive: /\b(driven|aggressive|competitive|decisive|ambitious|dominat\w*|fearless|hunter)\b/i,
}

export function audit(
  people: Array<{ gender: string; region: string; field: string; seniority: string; openToWork: boolean; text: string }>
) {
  const lines: Array<string> = []
  const tally = (key: (p: (typeof people)[number]) => string) => {
    const m = new Map<string, number>()
    for (const p of people) m.set(key(p), (m.get(key(p)) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1])
  }
  lines.push(`people: ${people.length}`)
  lines.push(`gender: ${tally((p) => p.gender).map(([k, v]) => `${k} ${v}`).join(", ")}`)
  lines.push(`name region: ${tally((p) => p.region).map(([k, v]) => `${k} ${v}`).join(", ")}`)
  lines.push(`seniority × gender: ${SENIORITIES.map((s) => `${s} ${["woman", "man", "nonbinary"].map((g) => people.filter((p) => p.seniority === s && p.gender === g).length).join("/")}`).join(", ")}  (w/m/nb)`)
  lines.push(`open to work × gender: ${["woman", "man", "nonbinary"].map((g) => `${g} ${people.filter((p) => p.gender === g && p.openToWork).length}/${people.filter((p) => p.gender === g).length}`).join(", ")}`)
  const skewed: Array<string> = []
  for (const [field] of tally((p) => p.field)) {
    const inField = people.filter((p) => p.field === field)
    const w = inField.filter((p) => p.gender === "woman").length
    const m = inField.filter((p) => p.gender === "man").length
    if (inField.length >= 2 && (w === 0 || m === 0)) skewed.push(`${field} (${w} w / ${m} m)`)
  }
  lines.push(`fields with only one gender (of ≥ 2 people): ${skewed.length ? skewed.join(", ") : "none"}`)
  const regionsBySenior = tally((p) => (p.seniority === "lead" || p.seniority === "senior" ? p.region : "")).filter(([k]) => k)
  lines.push(`senior + lead by name region: ${regionsBySenior.map(([k, v]) => `${k} ${v}`).join(", ")}`)
  lines.push(`gendered words in profile text: ${people.filter((p) => GENDERED.test(p.text)).length}`)
  for (const [trait, re] of Object.entries(TRAITS)) {
    lines.push(`“${trait}” wording: ${["woman", "man", "nonbinary"].map((g) => `${g} ${people.filter((p) => p.gender === g && re.test(p.text)).length}/${people.filter((p) => p.gender === g).length}`).join(", ")}`)
  }
  lines.push(`protected terms (the matching list) in profile text: ${people.filter((p) => findProtectedTerms(p.text).length).length}`)
  return lines
}

// --- run: --audit ------------------------------------------------------------------

const args = process.argv.slice(2)
if (args.includes("--audit")) {
  const cast = (await Bun.file(join(OUT, "people.json")).json()) as { people: Array<any> }
  for (const line of audit(cast.people.map(auditRow))) console.log(line)
  process.exit(0)
}

function auditRow(p: any) {
  return {
    gender: p.plan.gender,
    region: p.plan.region,
    field: p.plan.field,
    seniority: p.plan.seniority,
    openToWork: p.profile.openToWork,
    text: [p.profile.headline, p.profile.about, ...p.positions.map((x: any) => `${x.title} ${x.description ?? ""}`)].join(" "),
  }
}

if (!process.env.MISTRAL_API_KEY) {
  console.log("✗ MISTRAL_API_KEY is not set (apps/appview/.env)")
  process.exit(1)
}

// --- run: --naive ------------------------------------------------------------------

if (args.includes("--naive")) {
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1]! : join(OUT, "naive")
  mkdirSync(out, { recursive: true })
  const people: Array<z.infer<typeof NaivePersonOut>> = []
  for (let batch = 0; people.length < 54 && batch < 12; batch++) {
    const got = await ask(NaiveBatchOut, naivePrompt(6, people.map((p) => p.displayName)), 8000)
    for (const p of got.people) {
      if (checkPerson(p, `naive ${p.displayName}`)) people.push(p)
    }
    console.log(`  batch ${batch + 1}: ${people.length} people`)
  }
  const rows = people.map((p) => ({
    gender: p.audit.gender,
    region: p.audit.nameOrigin,
    field: p.audit.field.toLowerCase(),
    seniority: p.audit.seniority,
    openToWork: p.openToWork,
    text: [p.headline, p.about, ...p.positions.map((x) => `${x.title} ${x.description}`)].join(" "),
  }))
  const report = audit(rows)
  await Bun.write(join(out, "naive-people.json"), JSON.stringify({ model: DEMO_MODEL, temperature: TEMPERATURE, prompt: naivePrompt(6, []), people }, null, 1) + "\n")
  await Bun.write(join(out, "naive-audit.txt"), report.join("\n") + "\n")
  for (const line of report) console.log(line)
  const cost = costOf(DEMO_MODEL, usage.prompt, usage.completion)
  console.log(`\n${usage.calls} calls, ${usage.prompt} in + ${usage.completion} out tokens ≈ $${cost.toFixed(4)} on ${DEMO_MODEL}`)
  process.exit(0)
}

// --- run: the planned cast ---------------------------------------------------------

mkdirSync(OUT, { recursive: true })
const started = new Date()
const slots = plan()
console.log(`${slots.length} planned people, ${DEMO_MODEL} at temperature ${TEMPERATURE}`)

const people: Array<{ handle: string; plan: Slot; profile: Record<string, unknown>; positions: Array<Record<string, unknown>>; education: Array<Record<string, unknown>> }> = []
const handles = new Set<string>()
const names = new Map<number, string>()

// Names first, one region at a time, each call told the names already taken.
const byRegion = new Map<string, Array<Slot>>()
for (const slot of slots) byRegion.set(slot.region, [...(byRegion.get(slot.region) ?? []), slot])
await pool([...byRegion.values()], 5, async (group) => {
  for (const slot of group) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const taken = [...names.values()]
      const { displayName } = await ask(NameOut, namePrompt(slot, taken), 100)
      const first = slug(displayName).split("-")[0]!
      const clash = taken.find((t) => slug(t) === slug(displayName) || slug(t).split("-")[0] === first)
      if (clash) {
        drop(`name for slot ${slot.index} (attempt ${attempt})`, `“${displayName}” repeats “${clash}”`)
        continue
      }
      names.set(slot.index, displayName)
      break
    }
  }
})

await pool(slots, 4, async (slot) => {
  const displayName = names.get(slot.index)
  if (!displayName) return drop(`slot ${slot.index}`, "no unique name")
  for (let attempt = 1; attempt <= 3; attempt++) {
    const p = { ...(await ask(ProfileOut, personPrompt(slot))), displayName }
    if (!checkPerson(p, `person ${slot.index} (${slot.field}, attempt ${attempt})`)) continue
    let handle = `${slug(p.displayName)}.test`
    if (handles.has(handle)) handle = `${slug(p.displayName)}-${slot.index}.test`
    handles.add(handle)
    people.push({
      handle,
      plan: slot,
      profile: {
        displayName: p.displayName,
        headline: p.headline,
        about: p.about,
        location: slot.location,
        openToWork: slot.openToWork,
        skills: [...new Set(p.skills)].slice(0, 10),
      },
      positions: p.positions.map(positionRecord),
      education: p.education,
    })
    console.log(`  ${String(slot.index).padStart(2)} ${slot.field.padEnd(11)} ${slot.seniority.padEnd(6)} ${handle}`)
    return
  }
  drop(`slot ${slot.index}`, "no valid person after 3 attempts")
})
people.sort((a, b) => a.plan.index - b.plan.index)

// --- communities and threads -------------------------------------------------------

const COMMUNITIES: Array<{ key: string; name: string; topic: string; fields: Array<FieldKey> }> = [
  { key: "data-analytics", name: "Data & Analytics Practitioners", topic: "Data engineering and data science", fields: ["dataeng", "datascience", "backend"] },
  { key: "clinical-practice", name: "Nursing & Clinical Practice", topic: "Nursing", fields: ["nursing"] },
  { key: "design-critique", name: "Design & Product Critique", topic: "Product design", fields: ["design", "frontend", "pm", "mobile"] },
  { key: "built-world", name: "The Built World", topic: "Engineering and operations", fields: ["mecheng", "civileng", "supplychain", "sre"] },
  { key: "careers-hiring", name: "Careers & Hiring in the Open", topic: "Careers", fields: ["recruiting", "sales", "marketing", "finance", "legal", "teaching"] },
]

const communities: Array<Record<string, unknown>> = []
await pool(COMMUNITIES, 2, async (c) => {
  const members = people.filter((p) => c.fields.includes(p.plan.field))
  const creator = members.find((p) => p.plan.seniority === "lead") ?? members[0]!
  const others = people.filter((p) => !c.fields.includes(p.plan.field))
  const cast = [...members, ...others.slice(c.key.length % 5, (c.key.length % 5) + 4)]
  const list = cast.map((p) => `- ${p.handle}: ${p.profile.displayName}, ${p.profile.headline}${members.includes(p) ? "" : " (not a member: may reply, never start a thread)"}`).join("\n")
  const prompt = `Write the community "${c.name}" (topic: ${c.topic}) on a professional network that favours long-form, specific posts over hot takes.

Its members and a few visitors, by handle:
${list}

Write a description, 3 rules, and 4 threads. Each thread is started by a member and has 1 to 4 replies from different people in the list. Threads are about real, specific problems in the work: a lesson learned, a question with enough context to answer, a disagreement handled well. Use handles exactly as listed.`
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await ask(CommunityOut, prompt, 7000)
    const known = new Set(cast.map((p) => p.handle))
    const memberSet = new Set(members.map((p) => p.handle))
    const threads = out.threads.filter((t, i) => {
      const label = `${c.key} thread ${i}`
      if (!memberSet.has(t.author)) return (drop(label, `started by ${t.author}, not a member`), false)
      for (const [j, r] of t.replies.entries()) {
        if (!known.has(r.author)) return (drop(label, `reply ${j + 1} by unknown ${r.author}`), false)
        if (r.replyTo < 0 || r.replyTo > j) return (drop(label, `reply ${j + 1} points at ${r.replyTo}`), false)
      }
      for (const text of [t.text, ...t.replies.map((r) => r.text)]) {
        const bad = checkPostText(text) ?? (REAL_ORGS.test(text) ? `names a real organisation (“${text.match(REAL_ORGS)![0]}”)` : undefined)
        if (bad) return (drop(label, bad), false)
      }
      return true
    })
    const bad = checkCommunity({ name: c.name, topic: c.topic })
    if (bad) throw new Error(`${c.key}: ${bad}`)
    if (threads.length < 2) {
      drop(`${c.key} attempt ${attempt}`, `only ${threads.length} valid thread(s)`)
      continue
    }
    communities.push({
      key: c.key,
      name: c.name,
      topic: c.topic,
      creator: creator.handle,
      members: members.map((p) => p.handle),
      description: out.description,
      rules: out.rules.slice(0, 5),
      threads,
    })
    console.log(`  community ${c.key}: ${members.length} members, ${threads.length} threads, ${threads.reduce((a, t) => a + t.replies.length, 0)} replies`)
    return
  }
})
communities.sort((a, b) => COMMUNITIES.findIndex((c) => c.key === a.key) - COMMUNITIES.findIndex((c) => c.key === b.key))

// --- job postings --------------------------------------------------------------------

/**
 * 20 postings. The poster is a recruiter or a lead in the field; pay is set
 * by the model but checked by the salary rules. Currency and period follow
 * the city, so a posting in Nairobi pays in KES.
 */
const CURRENCY: Record<string, string> = { NG: "NGN", GH: "GHS", SN: "XOF", CI: "XOF", KE: "KES", RW: "RWF", ET: "ETB", UG: "UGX", ZA: "ZAR", ZM: "ZMW", BW: "BWP", EG: "EGP", MA: "MAD", TN: "TND", JO: "JOD", LB: "USD", AE: "AED", TR: "TRY", IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", KR: "KRW", TW: "TWD", JP: "JPY", CN: "CNY", PH: "PHP", ID: "IDR", VN: "VND", MY: "MYR", Singapore: "SGD", BR: "BRL", MX: "MXN", CO: "COP", PE: "PEN", AR: "ARS", JM: "JMD", TT: "TTD", DE: "EUR", PT: "EUR", NL: "EUR", FR: "EUR", IE: "EUR", ES: "EUR", PL: "PLN", RO: "RON", UA: "UAH", EE: "EUR", CZ: "CZK", SE: "SEK", NO: "NOK", FI: "EUR", DK: "DKK", CA: "CAD", US: "USD", NZ: "NZD", AU: "AUD", FJ: "FJD" }
const recruiters = people.filter((p) => p.plan.field === "recruiting")
const leads = people.filter((p) => p.plan.seniority === "lead")
const postingPlan = Array.from({ length: 20 }, (_, i) => {
  const rand = prng(SEED + 1000 + i)
  const field = (Object.keys(FIELDS) as Array<FieldKey>)[(i * 7) % 18]!
  const leadInField = leads.find((p) => p.plan.field === field)
  const by = i % 3 === 0 && leadInField ? leadInField : recruiters[i % recruiters.length]!
  const allCities = Object.values(REGIONS).flatMap((r) => r.cities)
  const city = allCities[(i * 7 + 3) % allCities.length]!
  const country = city.split(", ")[1] ?? city
  return {
    index: i,
    by: by.handle,
    field,
    seniority: SENIORITIES[(i + 1) % 4]!,
    city,
    currency: CURRENCY[country] ?? "USD",
    period: (["year", "year", "month", "year", "hour"] as const)[i % 5]!,
    locationType: WORKPLACE[Math.floor(rand() * 3)]!,
    employmentType: i % 7 === 3 ? "contract" : i % 11 === 5 ? "part-time" : "full-time",
  }
})

const postings: Array<Record<string, unknown>> = []
await pool(postingPlan, 3, async (pp) => {
  const prompt = `Write one job posting.

- Role: ${pp.seniority} role in ${FIELDS[pp.field]}
- Based in: ${pp.city} (${pp.locationType}), ${pp.employmentType}
- Pay: in ${pp.currency}, stated PER ${pp.period.toUpperCase()} (not per year unless the period is year), a realistic range for this role, seniority and city. Whole units, no decimals. salaryMax between 1.1 and 1.6 times salaryMin. Also give annualMinEquivalent: salaryMin for a full-time year (2080 hours, 260 days, 52 weeks or 12 months).

Say what the work is, who the team is and what they need. Requirements must be about the job: skills and experience, never age, "young", "energetic", "digital native", "native speaker", gender or background.`
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await ask(PostingOut, prompt, 2000)
    const record = {
      title: out.title,
      organization: out.organization,
      description: out.description,
      location: pp.city,
      locationType: pp.locationType,
      employmentType: pp.employmentType,
      skills: [...new Set(out.skills)].slice(0, 25),
      salary: { min: out.salaryMin, max: out.salaryMax, currency: pp.currency, period: pp.period },
    }
    const label = `posting ${pp.index} (${out.title}, attempt ${attempt})`
    const perYear = { hour: 2080, day: 260, week: 52, month: 12, year: 1 }[pp.period]
    const bad =
      (Math.abs(out.salaryMin * perYear - out.annualMinEquivalent) > 0.15 * out.annualMinEquivalent
        ? `pay per ${pp.period} (${out.salaryMin}) disagrees with its own yearly figure (${out.annualMinEquivalent})`
        : undefined) ??
      checkPosting(record as never) ??
      (REAL_ORGS.test(`${out.organization} ${out.description}`) ? "names a real organisation" : undefined)
    if (bad) {
      drop(label, bad)
      continue
    }
    try {
      sh.authentiq.job.posting.$parse({ $type: sh.authentiq.job.posting.$type, ...record, createdAt: new Date().toISOString() })
    } catch (err) {
      drop(label, `lexicon: ${(err as Error).message}`)
      continue
    }
    const flagged = findProtectedTerms(out.description)
    postings.push({ key: `posting-${pp.index}`, by: pp.by, field: pp.field, record, ...(flagged.length ? { protectedTerms: flagged } : {}) })
    console.log(`  posting ${String(pp.index).padStart(2)} ${pp.field.padEnd(11)} ${pp.currency} ${out.salaryMin}–${out.salaryMax}/${pp.period}  ${out.title}${flagged.length ? `  (flagged: ${flagged.join(", ")})` : ""}`)
    return
  }
  drop(`posting ${pp.index}`, "no valid posting after 3 attempts")
})
postings.sort((a, b) => Number(String(a.key).split("-")[1]) - Number(String(b.key).split("-")[1]))

// --- write ----------------------------------------------------------------------------

const cost = costOf(DEMO_MODEL, usage.prompt, usage.completion)
const report = audit(people.map(auditRow))
await Bun.write(join(OUT, "people.json"), JSON.stringify({ people }, null, 1) + "\n")
await Bun.write(join(OUT, "communities.json"), JSON.stringify({ communities }, null, 1) + "\n")
await Bun.write(join(OUT, "postings.json"), JSON.stringify({ postings }, null, 1) + "\n")
await Bun.write(
  join(OUT, "meta.json"),
  JSON.stringify(
    {
      generatedAt: started.toISOString(),
      model: DEMO_MODEL,
      temperature: TEMPERATURE,
      seed: SEED,
      script: "infra/scripts/gen-demo-data.ts (bun run fixtures:demo)",
      prompts: {
        system: SYSTEM_PROMPT,
        name: namePrompt({ index: 0, field: "backend", seniority: "mid", gender: "woman", region: "West Africa", location: "Lagos, NG", openToWork: true }, ["…names already taken"]),
        person: personPrompt({ index: 0, field: "backend", seniority: "mid", gender: "woman", region: "West Africa", location: "Lagos, NG", openToWork: true }),
        community: "see COMMUNITIES and the community prompt in the script",
        posting: "see postingPlan and the posting prompt in the script",
      },
      usage: { ...usage, costUsd: cost },
      dropped: errors,
      audit: report,
    },
    null,
    1
  ) + "\n"
)
console.log(`\n${report.join("\n")}`)
console.log(`\ndropped: ${errors.length}`)
console.log(`${usage.calls} calls, ${usage.prompt} in + ${usage.completion} out tokens ≈ $${cost.toFixed(4)} on ${DEMO_MODEL}`)
