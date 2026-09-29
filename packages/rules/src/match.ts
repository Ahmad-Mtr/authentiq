/**
 * Bands of cosine similarity between a profile document and a posting
 * document (mistral-embed), phase 7. Chosen from the distribution over the
 * talent corpus and the seeded postings: see the phase 7 doc, "Match score".
 * A label, not a percentage: the similarity of two embeddings is not a
 * probability of anything, and two decimals would claim a precision it
 * does not have.
 *
 * Shared by the AppView (a seeker's own match label) and the first-party
 * feed generator (jobs-for-you keeps partial and strong matches), so both
 * draw the line in the same place.
 */
export const MATCH_BANDS = { strong: 0.84, partial: 0.8 } as const

export type MatchLabel = "strong" | "partial" | "weak"

export const matchLabel = (similarity: number): MatchLabel =>
  similarity >= MATCH_BANDS.strong
    ? "strong"
    : similarity >= MATCH_BANDS.partial
      ? "partial"
      : "weak"
