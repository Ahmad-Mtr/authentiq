/**
 * Field-level scoring of a parsed resume draft against its hand annotation.
 * Used by `eval:resume` (all fixtures) and `verify:resume` (one fixture).
 *
 * Matching rules
 * --------------
 * Strings are normalised before comparing: Unicode NFKC, lower-cased, en/em
 * dashes → "-", curly quotes → straight, bullets ("•", "-", "*") stripped at
 * line starts, whitespace collapsed, trailing ".,;:" dropped. Diacritics are
 * kept: "Marés" ≠ "Mares", because the parser is told to copy as written.
 *
 *   - Short fields (names, titles, organizations, schools, degrees, fields of
 *     study, locations, employment/location type) match when the normalised
 *     strings are equal.
 *   - Long text (`about`, `description`) matches when the token F1 between the
 *     two is ≥ 0.8. Tokens are runs of letters/digits after normalisation.
 *   - Dates match only as identical strings: `2021` ≠ `2021-03`. A month the
 *     resume never gave is an error, not a near miss.
 *   - Skills are scored as a set: each normalised skill is one unit.
 *
 * Alignment. Predicted and expected positions are paired greedily by
 * similarity, best pair first: 0.4 × token-Jaccard(organization) + 0.4 ×
 * token-Jaccard(title) + 0.2 × (startDate equal). A pair needs ≥ 0.5.
 * Education pairs on 0.7 × Jaccard(school) + 0.3 × Jaccard(degree), same
 * threshold. Every position and school in the fixtures is distinguishable
 * this way (repeated titles differ by employer or start date).
 *
 * Counting, per field. Absent on both sides counts nothing.
 *   present in both, matching       → TP
 *   predicted only                  → FP
 *   expected only                   → FN
 *   present in both, not matching   → FP + FN (a wrong value is both)
 * An unpaired predicted entry makes every field it has an FP; an unpaired
 * expected entry makes every field it has an FN. Precision = TP/(TP+FP),
 * recall = TP/(TP+FN), micro-averaged over whatever is being reported.
 */

export type Draft = {
  profile: Record<string, unknown> & { skills?: Array<string> }
  positions: Array<Record<string, string | undefined>>
  education: Array<Record<string, string | undefined>>
}

export const PROFILE_FIELDS = [
  "displayName",
  "headline",
  "about",
  "location",
] as const
export const POSITION_FIELDS = [
  "title",
  "organization",
  "employmentType",
  "locationType",
  "location",
  "startDate",
  "endDate",
  "description",
] as const
export const EDUCATION_FIELDS = [
  "school",
  "degree",
  "fieldOfStudy",
  "startDate",
  "endDate",
] as const

const LONG_TEXT = new Set(["about", "description"])
const DATES = new Set(["startDate", "endDate"])
const TOKEN_F1_THRESHOLD = 0.8
const ALIGN_THRESHOLD = 0.5

export function normalize(s: string) {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/^\s*[•*-]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:]+$/, "")
}

const tokens = (s: string) => normalize(s).match(/[\p{L}\p{N}]+/gu) ?? []

function tokenF1(a: string, b: string) {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.length === 0 || tb.length === 0) return 0
  const counts = new Map<string, number>()
  for (const t of tb) counts.set(t, (counts.get(t) ?? 0) + 1)
  let overlap = 0
  for (const t of ta) {
    const n = counts.get(t) ?? 0
    if (n > 0) {
      overlap++
      counts.set(t, n - 1)
    }
  }
  if (overlap === 0) return 0
  const p = overlap / ta.length
  const r = overlap / tb.length
  return (2 * p * r) / (p + r)
}

function jaccard(a?: string, b?: string) {
  const ta = new Set(tokens(a ?? ""))
  const tb = new Set(tokens(b ?? ""))
  if (ta.size === 0 && tb.size === 0) return 1
  const inter = [...ta].filter((t) => tb.has(t)).length
  return inter / (ta.size + tb.size - inter)
}

export function fieldMatches(
  field: string,
  predicted: string,
  expected: string
) {
  if (DATES.has(field)) return predicted.trim() === expected.trim()
  if (LONG_TEXT.has(field))
    return tokenF1(predicted, expected) >= TOKEN_F1_THRESHOLD
  return normalize(predicted) === normalize(expected)
}

export type Counts = { tp: number; fp: number; fn: number }
export type FieldCounts = Map<string, Counts>
export type Mismatch = { field: string; predicted?: string; expected?: string }

export function score(predicted: Draft, expected: Draft) {
  const counts: FieldCounts = new Map()
  const mismatches: Array<Mismatch> = []
  const add = (key: string, c: Partial<Counts>) => {
    const cur = counts.get(key) ?? { tp: 0, fp: 0, fn: 0 }
    counts.set(key, {
      tp: cur.tp + (c.tp ?? 0),
      fp: cur.fp + (c.fp ?? 0),
      fn: cur.fn + (c.fn ?? 0),
    })
  }
  let inventedMonths = 0
  const compare = (
    key: string,
    field: string,
    p: unknown,
    e: unknown,
    label: string
  ) => {
    const ps = typeof p === "string" && p.trim() ? p : undefined
    const es = typeof e === "string" && e.trim() ? e : undefined
    if (!ps && !es) return
    if (ps && es && fieldMatches(field, ps, es)) return add(key, { tp: 1 })
    if (ps) add(key, { fp: 1 })
    if (es) add(key, { fn: 1 })
    mismatches.push({ field: label, predicted: ps, expected: es })
  }

  for (const f of PROFILE_FIELDS) {
    compare(
      `profile.${f}`,
      f,
      predicted.profile[f],
      expected.profile[f],
      `profile.${f}`
    )
  }

  const ps = new Set((predicted.profile.skills ?? []).map(normalize))
  const es = new Set((expected.profile.skills ?? []).map(normalize))
  const tp = [...ps].filter((s) => es.has(s))
  add("skills", {
    tp: tp.length,
    fp: ps.size - tp.length,
    fn: es.size - tp.length,
  })
  for (const s of ps)
    if (!es.has(s)) mismatches.push({ field: "skills", predicted: s })
  for (const s of es)
    if (!ps.has(s)) mismatches.push({ field: "skills", expected: s })

  const entities = (
    kind: "positions" | "education",
    fields: ReadonlyArray<string>,
    similarity: (
      a: Record<string, string | undefined>,
      b: Record<string, string | undefined>
    ) => number
  ) => {
    const pairs = align(predicted[kind], expected[kind], similarity)
    const label = (e: Record<string, string | undefined>) =>
      kind === "positions" ? `${e.title} @ ${e.organization}` : `${e.school}`
    for (const [pi, ei] of pairs) {
      for (const f of fields) {
        compare(
          `${kind}.${f}`,
          f,
          pi === undefined ? undefined : predicted[kind][pi]![f],
          ei === undefined ? undefined : expected[kind][ei]![f],
          `${kind}[${label((pi === undefined ? expected[kind][ei!] : predicted[kind][pi])!)}].${f}`
        )
      }
    }
    // A month the resume does not have: a YYYY-MM prediction where the
    // annotation has only a year, or no date at all.
    for (const [pi, ei] of pairs) {
      if (pi === undefined) continue
      for (const f of ["startDate", "endDate"]) {
        const p = predicted[kind][pi]![f]
        const e = ei === undefined ? undefined : expected[kind][ei]![f]
        if (p?.length === 7 && e?.length !== 7) inventedMonths++
      }
    }
    const paired = pairs.filter(
      ([p, e]) => p !== undefined && e !== undefined
    ).length
    return {
      predicted: predicted[kind].length,
      expected: expected[kind].length,
      paired,
    }
  }

  const positions = entities(
    "positions",
    POSITION_FIELDS,
    (a, b) =>
      0.4 * jaccard(a.organization, b.organization) +
      0.4 * jaccard(a.title, b.title) +
      0.2 * (a.startDate && a.startDate === b.startDate ? 1 : 0)
  )
  const education = entities(
    "education",
    EDUCATION_FIELDS,
    (a, b) =>
      0.7 * jaccard(a.school, b.school) + 0.3 * jaccard(a.degree, b.degree)
  )

  return { counts, mismatches, positions, education, inventedMonths }
}

/**
 * Greedy best-first pairing. Returns [predictedIndex, expectedIndex] pairs,
 * with `undefined` on one side for anything left unpaired.
 */
function align<T>(
  predicted: Array<T>,
  expected: Array<T>,
  similarity: (a: T, b: T) => number
): Array<[number | undefined, number | undefined]> {
  const candidates: Array<[number, number, number]> = []
  predicted.forEach((p, i) =>
    expected.forEach((e, j) => candidates.push([similarity(p, e), i, j]))
  )
  candidates.sort((a, b) => b[0] - a[0])
  const usedP = new Set<number>()
  const usedE = new Set<number>()
  const pairs: Array<[number | undefined, number | undefined]> = []
  for (const [s, i, j] of candidates) {
    if (s < ALIGN_THRESHOLD || usedP.has(i) || usedE.has(j)) continue
    usedP.add(i)
    usedE.add(j)
    pairs.push([i, j])
  }
  predicted.forEach((_, i) => usedP.has(i) || pairs.push([i, undefined]))
  expected.forEach((_, j) => usedE.has(j) || pairs.push([undefined, j]))
  return pairs
}

export function merge(into: FieldCounts, from: FieldCounts) {
  for (const [k, c] of from) {
    const cur = into.get(k) ?? { tp: 0, fp: 0, fn: 0 }
    into.set(k, { tp: cur.tp + c.tp, fp: cur.fp + c.fp, fn: cur.fn + c.fn })
  }
  return into
}

export function sum(counts: FieldCounts, keys?: (k: string) => boolean) {
  const out = { tp: 0, fp: 0, fn: 0 }
  for (const [k, c] of counts) {
    if (keys && !keys(k)) continue
    out.tp += c.tp
    out.fp += c.fp
    out.fn += c.fn
  }
  return out
}

export function prf({ tp, fp, fn }: Counts) {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1 }
}
