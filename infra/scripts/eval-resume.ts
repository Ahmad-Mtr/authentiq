/**
 * Resume parsing accuracy (phase 4). Runs the real pipeline, the same code
 * the AppView runs (byte sniffing → unpdf/mammoth → Mistral → lexicon-shaped
 * draft), on every fixture in infra/fixtures/resumes/ and scores it against
 * the hand annotation.
 *
 * Reports field-level precision and recall per field and per group (profile
 * fields, skills, positions, education), overall micro-averaged figures, and
 * token usage with an estimated cost. The matching rules (normalisation,
 * alignment, counting) are in ./lib/resume-score.ts.
 *
 *   bun run eval:resume                      # all fixtures
 *   bun run eval:resume -- --verbose         # also print every mismatch
 *   bun run eval:resume -- --only 02,09      # a subset, by prefix
 *   RESUME_PARSER_MODEL=ministral-14b-2512 bun run eval:resume
 *
 * Needs MISTRAL_API_KEY, read from apps/appview/.env. Calls the model once
 * per fixture, one at a time.
 */
import { join } from "node:path"
import { sh } from "@workspace/lexicons"
import {
  extractResumeText,
  sniffResumeType,
} from "../../apps/appview/src/resume/extract.ts"
import {
  parseResumeText,
  parserModel,
} from "../../apps/appview/src/resume/parse.ts"
import {
  EDUCATION_FIELDS,
  POSITION_FIELDS,
  PROFILE_FIELDS,
  merge,
  prf,
  score,
  sum,
} from "./lib/resume-score.ts"
import type { Draft, FieldCounts } from "./lib/resume-score.ts"

const root = join(import.meta.dir, "..", "..")
const FIXTURES = join(root, "infra", "fixtures", "resumes")

/** USD per million tokens, input / output. mistral.ai/pricing/api, 2026-09-29. */
const PRICES: Record<string, [number, number]> = {
  "ministral-3b-2512": [0.1, 0.1],
  "ministral-8b-2512": [0.15, 0.15],
  "ministral-14b-2512": [0.2, 0.2],
  "mistral-small-2603": [0.15, 0.6],
  "mistral-medium-2604": [1.5, 7.5],
}

const args = process.argv.slice(2)
const verbose = args.includes("--verbose")
const only = args.includes("--only")
  ? args[args.indexOf("--only") + 1]!.split(",")
  : undefined

for (const line of (
  await Bun.file(join(root, "apps/appview/.env")).text()
).split("\n")) {
  const m = line.match(/^(MISTRAL_API_KEY|RESUME_PARSER_MODEL)=(.+)$/)
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim()
}
if (!process.env.MISTRAL_API_KEY) {
  console.log("✗ MISTRAL_API_KEY is not set (apps/appview/.env)")
  process.exit(1)
}

const files = (
  await Array.fromAsync(new Bun.Glob("*.{pdf,docx}").scan(FIXTURES))
)
  .sort()
  .filter((f) => !only || only.some((o) => f.startsWith(o)))

const pct = (n: number) => `${(n * 100).toFixed(1)}%`.padStart(6)
const model = parserModel()
console.log(`model ${model}, ${files.length} fixture(s)\n`)

const total: FieldCounts = new Map()
const usage = { prompt: 0, completion: 0 }
let entityExtra = 0
let entityMissed = 0
let invented = 0
let failures = 0
let schemaInvalid = 0

for (const file of files) {
  const expected = sh.authentiq.resume.defs.draft.parse(
    await Bun.file(
      join(FIXTURES, file.replace(/\.(pdf|docx)$/, ".expected.json"))
    ).json()
  ) as Draft
  const bytes = new Uint8Array(
    await Bun.file(join(FIXTURES, file)).arrayBuffer()
  )
  const started = performance.now()
  let predicted: Draft
  try {
    const type = sniffResumeType(bytes)
    if (!type) throw new Error("not detected as PDF or DOCX")
    const text = await extractResumeText(bytes, type)
    const result = await parseResumeText(text)
    usage.prompt += result.usage.promptTokens
    usage.completion += result.usage.completionTokens
    predicted = result.draft as Draft
  } catch (err) {
    failures++
    console.log(`✗ ${file.padEnd(30)} failed: ${(err as Error).message}`)
    // A failed parse scores as an empty draft: everything is a miss.
    predicted = { profile: {}, positions: [], education: [] }
  }
  const ms = Math.round(performance.now() - started)

  // The draft must satisfy the lexicon whatever the resume says.
  if (!sh.authentiq.resume.defs.draft.$matches(predicted)) schemaInvalid++

  const s = score(predicted, expected)
  merge(total, s.counts)
  entityExtra +=
    s.positions.predicted -
    s.positions.paired +
    (s.education.predicted - s.education.paired)
  entityMissed +=
    s.positions.expected -
    s.positions.paired +
    (s.education.expected - s.education.paired)
  invented += s.inventedMonths
  const { precision, recall } = prf(sum(s.counts))
  console.log(
    `${file.padEnd(30)} P ${pct(precision)}  R ${pct(recall)}  ` +
      `positions ${s.positions.paired}/${s.positions.expected} (+${s.positions.predicted - s.positions.paired})  ` +
      `education ${s.education.paired}/${s.education.expected} (+${s.education.predicted - s.education.paired})  ` +
      `${ms} ms`
  )
  if (verbose) {
    for (const m of s.mismatches) {
      console.log(
        `    ${m.field}: got ${JSON.stringify(m.predicted ?? null)}, expected ${JSON.stringify(m.expected ?? null)}`
      )
    }
  }
}

const row = (label: string, keys: (k: string) => boolean) => {
  const c = sum(total, keys)
  const { precision, recall, f1 } = prf(c)
  console.log(
    `${label.padEnd(26)} P ${pct(precision)}  R ${pct(recall)}  F1 ${pct(f1)}   (tp ${c.tp}, fp ${c.fp}, fn ${c.fn})`
  )
}

console.log("\nper field")
for (const f of PROFILE_FIELDS)
  row(`  profile.${f}`, (k) => k === `profile.${f}`)
row("  skills", (k) => k === "skills")
for (const f of POSITION_FIELDS)
  row(`  positions.${f}`, (k) => k === `positions.${f}`)
for (const f of EDUCATION_FIELDS)
  row(`  education.${f}`, (k) => k === `education.${f}`)

console.log("\nper group")
row("  profile fields", (k) => k.startsWith("profile."))
row("  skills", (k) => k === "skills")
row("  positions", (k) => k.startsWith("positions."))
row("  education", (k) => k.startsWith("education."))
console.log("")
row("overall (micro)", () => true)

const [inPrice, outPrice] = PRICES[model] ?? [Number.NaN, Number.NaN]
const cost = (usage.prompt * inPrice + usage.completion * outPrice) / 1e6
console.log(
  `\nentries: ${entityMissed} expected entries missed, ${entityExtra} extra entries proposed`
)
console.log(`invented months: ${invented}`)
console.log(
  `failed parses: ${failures}, drafts outside the lexicon: ${schemaInvalid}`
)
console.log(
  `tokens: ${usage.prompt} in + ${usage.completion} out ≈ $${cost.toFixed(4)} on ${model}` +
    (Number.isNaN(cost) ? " (no price on file)" : "")
)
process.exit(failures === 0 && schemaInvalid === 0 ? 0 : 1)
