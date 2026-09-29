/**
 * Business rules the lexicons cannot express. Lexicons have no regex
 * constraint, so these run at index time and the AppView is the authority
 * (ADR 0001). The web editor duplicates some of them for UX.
 */

/** `YYYY` or `YYYY-MM`, as documented on the position and education lexicons. */
const PARTIAL_DATE = /^\d{4}(-(0[1-9]|1[0-2]))?$/

/**
 * Checks optional start/end partial dates. Returns a reason when invalid.
 *
 * Mixed precision compares by the widest reading: `2024` as an end date means
 * "some time in 2024", so it is not before a `2024-06` start.
 */
export function checkDateRange(
  startDate: string | undefined,
  endDate: string | undefined
): string | undefined {
  for (const [name, value] of [
    ["startDate", startDate],
    ["endDate", endDate],
  ] as const) {
    if (value !== undefined && !PARTIAL_DATE.test(value)) {
      return `${name} must be YYYY or YYYY-MM (got ${JSON.stringify(value)})`
    }
  }
  if (startDate && endDate) {
    const earliestStart = startDate.length === 4 ? `${startDate}-01` : startDate
    const latestEnd = endDate.length === 4 ? `${endDate}-12` : endDate
    if (latestEnd < earliestStart) {
      return `endDate ${endDate} is before startDate ${startDate}`
    }
  }
  return undefined
}
