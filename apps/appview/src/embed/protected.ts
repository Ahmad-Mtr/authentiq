/**
 * Protected attributes, and the words that stand in for them.
 *
 * Talent search must not rank by age, gender, race, ethnicity, national
 * origin, religion, disability, sexual orientation, marital or family status,
 * or pregnancy. This list is applied on both sides of the match:
 *
 *   - `redactDocument` strips these terms (plus calendar years and stated
 *     ages) from the documents we embed and full-text index, so a profile
 *     cannot be found *because* of them;
 *   - `stripQuery` removes them from search queries, so asking for "young
 *     women engineers" searches for "engineers" and says what it dropped.
 *
 * A word list is blunt. It misses paraphrases ("fresh-faced", "recent
 * immigrant") and removes some innocent uses ("church" in an employer's name,
 * "women's health" as a nursing specialty). The misses are the known gap; the
 * false removals only make a document or query slightly less specific.
 */

const TERMS = {
  age: [
    "age",
    "aged",
    "ages",
    "ageing",
    "aging",
    "young",
    "younger",
    "youngest",
    "youth",
    "youthful",
    "old",
    "older",
    "oldest",
    "elderly",
    "senior citizen",
    "retiree",
    "millennial",
    "millennials",
    "gen z",
    "gen-z",
    "zoomer",
    "zoomers",
    "boomer",
    "boomers",
    "baby boomer",
    "digital native",
    "digital natives",
    "twenties",
    "thirties",
    "forties",
    "fifties",
    "sixties",
    "seventies",
    "born",
  ],
  gender: [
    "male",
    "males",
    "female",
    "females",
    "man",
    "men",
    "woman",
    "women",
    "gender",
    "genders",
    "sex",
    "he",
    "him",
    "his",
    "himself",
    "she",
    "her",
    "hers",
    "herself",
    "boy",
    "boys",
    "girl",
    "girls",
    "guy",
    "guys",
    "lady",
    "ladies",
    "gentleman",
    "gentlemen",
    "masculine",
    "feminine",
    "nonbinary",
    "non-binary",
    "transgender",
    "mother",
    "mothers",
    "father",
    "fathers",
    "mom",
    "moms",
    "dad",
    "dads",
    "wife",
    "husband",
    "pregnant",
    "pregnancy",
  ],
  ethnicity: [
    "race",
    "racial",
    "ethnic",
    "ethnicity",
    "nationality",
    "citizenship",
    "white",
    "black",
    "asian",
    "hispanic",
    "latino",
    "latina",
    "latinx",
    "caucasian",
    "african american",
    "arab",
    "indigenous",
    "native american",
    "immigrant",
    "immigrants",
  ],
  religion: [
    "religion",
    "religious",
    "christian",
    "christians",
    "muslim",
    "muslims",
    "islamic",
    "jewish",
    "jew",
    "jews",
    "hindu",
    "buddhist",
    "sikh",
    "catholic",
    "protestant",
    "evangelical",
    "atheist",
    "church",
    "mosque",
    "synagogue",
    "temple",
  ],
  disability: [
    "disabled",
    "disability",
    "disabilities",
    "handicapped",
    "able-bodied",
    "wheelchair",
    "blind",
    "deaf",
    "autistic",
    "autism",
    "adhd",
    "neurodivergent",
    "neurotypical",
    "mental illness",
  ],
  orientation: [
    "gay",
    "lesbian",
    "bisexual",
    "queer",
    "lgbt",
    "lgbtq",
    "lgbtq+",
    "heterosexual",
    "homosexual",
  ],
  family: [
    "married",
    "unmarried",
    "divorced",
    "spouse",
    "childless",
    "no kids",
    "no children",
    "has kids",
    "has children",
  ],
} as const

export type ProtectedCategory = keyof typeof TERMS

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Longest first, so "senior citizen" wins over a shorter overlap. */
const words = Object.values(TERMS)
  .flat()
  .sort((a, b) => b.length - a.length)
  .map((t) => escape(t).replace(/[ -]/g, "[\\s-]"))

// Letters on either side mean it is part of a longer word ("hold", "manage").
// A few compounds are job vocabulary, not attributes: "black-box testing",
// "Six Sigma black belt", "white paper".
const TERM_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}]|[\\s-](?:box|belt|paper|list|hat)\\b)`,
  "giu"
)

/** "she/her", "they/them/theirs" and the like. */
const PRONOUNS_RE =
  /(?<![\p{L}])(?:he|she|they|xe|ze|it)\s*\/\s*(?:him|her|them|xem|zir|hir|its)(?:\s*\/\s*\p{L}+)?(?![\p{L}])/giu

/**
 * Stated ages and calendar years; years proxy age (graduation, "since 1998").
 * "under 30" counts only where it ends the phrase: "over 10 years of
 * experience" is about experience and stays.
 */
const AGE_RE =
  /(?<![\p{L}\p{N}])(?:\d{1,3}\s*(?:-|\s)?\s*(?:years?|yrs?)(?:\s*|-)old|aged?\s+\d{1,3}|(?:under|over|below|above)\s+\d{2}(?=\s*(?:$|[,.;!?)]|and\b|or\b|years?\s+old))|\d0s|(?:19|20)\d{2}s?)(?![\p{L}\p{N}])/giu

const tidy = (s: string) =>
  s
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ([,.;:!?)])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/\( ?\)/g, "")
    .replace(/ ?\n ?/g, "\n")
    .trim()

/** Document text with protected terms, pronoun sets, ages and years removed. */
export function redactDocument(text: string): string {
  return tidy(
    text.replace(PRONOUNS_RE, " ").replace(AGE_RE, " ").replace(TERM_RE, " ")
  )
}

/**
 * A search query with protected terms removed. `removed` lists what was
 * dropped (lower-cased, deduplicated), so callers can say so.
 */
export function stripQuery(query: string): {
  text: string
  removed: Array<string>
} {
  const removed = new Set<string>()
  const keep = (m: string) => {
    removed.add(m.toLowerCase().replace(/\s+/g, " "))
    return " "
  }
  const text = tidy(
    query
      .replace(PRONOUNS_RE, keep)
      .replace(AGE_RE, keep)
      .replace(TERM_RE, keep)
  )
  return { text, removed: [...removed] }
}
