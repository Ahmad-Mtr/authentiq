/**
 * Salary transparency (G5): what makes a `sh.authentiq.job.posting`'s salary
 * acceptable. The AppView's indexer enforces this (it is the authority, ADR
 * 0001: the PDS stores anything); the web form runs the same function so a
 * poster sees the problem before the record is written. Pure and
 * browser-safe: no Node APIs, no I/O.
 *
 * Amounts are **whole units of the currency** (85000 means 85,000 USD, not
 * cents). The AT Protocol data model has no floats, and whole units need no
 * per-currency minor-unit table (JPY has 0 decimals, BHD 3), so a client
 * cannot be off by a factor of 100 or 1000. The cost: an hourly rate of
 * 17.50 is written as a range such as 17–18.
 */

export const SALARY_PERIODS = ["hour", "day", "week", "month", "year"] as const
export type SalaryPeriod = (typeof SALARY_PERIODS)[number]

/**
 * Periods convert to a year with full-time assumptions, stated so they can be
 * shown: 40 hours × 52 weeks = 2080 hours; 5 days × 52 weeks = 260 days.
 * These are the conventions US and EU pay-transparency guidance uses for
 * annualising hourly pay. They are assumptions, not facts about a job.
 */
export const PERIODS_PER_YEAR: Record<SalaryPeriod, number> = {
  hour: 2080,
  day: 260,
  week: 52,
  month: 12,
  year: 1,
}

/**
 * The widest range allowed: `max ≤ MAX_SPREAD × min`. A posting reading
 * "$1 – $10,000,000" is transparency in name only. Pay-transparency laws ask
 * for a "good faith" range without fixing a ratio, so this is our line: 2×
 * still fits a band that spans two levels (say 120k–200k), and anything wider
 * says nothing about what the job pays. min = max (a single figure) is fine.
 */
export const MAX_SPREAD = 2

/**
 * ISO 4217 List One, active currency codes, as of 2026-09. Left out: codes
 * that are not money one is paid in (precious metals XAU/XAG/XPT/XPD, XDR,
 * the bond-market units XBA–XBD, testing XTS, no-currency XXX, XSU, XUA),
 * fund and accounting codes (BOV, CHE, CHW, CLF, COU, MXV, USN, UYI, UYW),
 * and withdrawn ones (ANG → XCG in 2025, BGN → EUR in 2026, HRK, SLL, ZWL,
 * CUC). A new currency is one line here, and both the AppView and the web
 * form pick it up together.
 */
export const CURRENCIES: ReadonlySet<string> = new Set(
  (
    "AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL " +
    "BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP " +
    "DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG " +
    "HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD " +
    "KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK " +
    "MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR " +
    "RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP " +
    "SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VED VES VND " +
    "VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG"
  ).split(" ")
)

/** Currencies to offer first in a picker; any code in CURRENCIES is valid. */
export const COMMON_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "CHF",
  "JPY",
  "INR",
  "AED",
  "SGD",
  "BRL",
  "PLN",
] as const

export type Salary = {
  min: number
  max: number
  currency: string
  period: string
}

/** Where a problem is, for forms: which salary field to mark. */
export type SalaryIssue = {
  field: "min" | "max" | "currency" | "period" | "salary"
  message: string
}

const isWhole = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n)

/**
 * Every problem with a salary, in the order a reader would fix them. Empty
 * means valid. `salary` is `unknown` because the indexer sees records exactly
 * as they arrived from a repo.
 */
export function salaryIssues(salary: unknown): Array<SalaryIssue> {
  if (salary === undefined || salary === null) {
    return [
      {
        field: "salary",
        message: "A salary range is required: every posting says what it pays",
      },
    ]
  }
  if (typeof salary !== "object") {
    return [{ field: "salary", message: "salary must be an object" }]
  }
  const s = salary as Record<string, unknown>
  const issues: Array<SalaryIssue> = []
  for (const field of ["min", "max", "currency", "period"] as const) {
    if (s[field] === undefined || s[field] === null || s[field] === "") {
      issues.push({ field, message: `salary is missing ${field}` })
    }
  }
  const { min, max, currency, period } = s

  if (min !== undefined && !(isWhole(min) && min > 0)) {
    issues.push({
      field: "min",
      message: `The minimum must be a whole number above 0 (got ${String(min)})`,
    })
  }
  if (max !== undefined && !(isWhole(max) && max > 0)) {
    issues.push({
      field: "max",
      message: `The maximum must be a whole number above 0 (got ${String(max)})`,
    })
  }
  if (isWhole(min) && isWhole(max) && min > 0 && max > 0) {
    if (min > max) {
      issues.push({
        field: "max",
        message: `The minimum (${min}) is above the maximum (${max})`,
      })
    } else if (max > MAX_SPREAD * min) {
      issues.push({
        field: "max",
        message: `The range ${min}–${max} is too wide: the maximum can be at most ${MAX_SPREAD}× the minimum (${MAX_SPREAD * min})`,
      })
    }
  }
  if (
    currency !== undefined &&
    currency !== "" &&
    !(typeof currency === "string" && CURRENCIES.has(currency))
  ) {
    issues.push({
      field: "currency",
      message: `Unknown currency ${JSON.stringify(currency)}: use an ISO 4217 code such as USD or EUR`,
    })
  }
  if (
    period !== undefined &&
    period !== "" &&
    !(SALARY_PERIODS as ReadonlyArray<unknown>).includes(period)
  ) {
    issues.push({
      field: "period",
      message: `Unknown pay period ${JSON.stringify(period)}: use one of ${SALARY_PERIODS.join(", ")}`,
    })
  }
  return issues
}

/** The first problem as a log reason, or undefined when the salary is valid. */
export function checkSalary(salary: unknown): string | undefined {
  return salaryIssues(salary)[0]?.message
}

/** An amount per `period` as a yearly amount, rounded to whole units. */
export function annualize(amount: number, period: SalaryPeriod): number {
  return Math.round(amount * PERIODS_PER_YEAR[period])
}

export const isSalaryPeriod = (p: unknown): p is SalaryPeriod =>
  (SALARY_PERIODS as ReadonlyArray<unknown>).includes(p)

/**
 * A salary for display: "USD 120,000–150,000 a year". Uses Intl for digit
 * grouping only; the currency is shown as its code, which is unambiguous
 * ("$" could be any of a dozen dollars).
 */
export function formatSalary(s: Salary, locale = "en") {
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
  const range =
    s.min === s.max ? n.format(s.min) : `${n.format(s.min)}–${n.format(s.max)}`
  const per = isSalaryPeriod(s.period)
    ? PERIOD_LABEL[s.period]
    : `per ${s.period}`
  return `${s.currency} ${range} ${per}`
}

export const PERIOD_LABEL: Record<SalaryPeriod, string> = {
  hour: "an hour",
  day: "a day",
  week: "a week",
  month: "a month",
  year: "a year",
}
