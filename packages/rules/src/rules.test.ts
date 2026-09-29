import { describe, expect, test } from "bun:test"
import {
  checkApplyUrl,
  checkCloseDate,
  checkPosting,
  closesAt,
} from "./posting.ts"
import {
  findProtectedTerms,
  redactDocument,
  redactJobText,
  stripJobQuery,
  stripQuery,
} from "./protected.ts"
import {
  CURRENCIES,
  annualize,
  checkSalary,
  formatSalary,
  salaryIssues,
} from "./salary.ts"

const salary = { min: 100_000, max: 150_000, currency: "USD", period: "year" }

describe("salary transparency", () => {
  test("a complete, sensible range is valid", () => {
    expect(checkSalary(salary)).toBeUndefined()
    expect(checkSalary({ ...salary, min: 90_000, max: 90_000 })).toBeUndefined()
    expect(checkSalary({ ...salary, max: 200_000 })).toBeUndefined()
  })
  test("no salary at all", () => {
    expect(checkSalary(undefined)).toMatch(/salary range is required/)
  })
  test("each part is required", () => {
    for (const field of ["min", "max", "currency", "period"] as const) {
      const { [field]: _, ...rest } = salary
      expect(checkSalary(rest)).toBe(`salary is missing ${field}`)
    }
  })
  test("min must be positive and whole", () => {
    expect(checkSalary({ ...salary, min: 0 })).toMatch(/above 0 \(got 0\)/)
    expect(checkSalary({ ...salary, min: -5 })).toMatch(/above 0/)
    expect(checkSalary({ ...salary, min: 17.5 })).toMatch(/whole number/)
  })
  test("min above max", () => {
    expect(checkSalary({ ...salary, min: 150_000, max: 100_000 })).toMatch(
      /minimum \(150000\) is above the maximum \(100000\)/
    )
  })
  test("a range wider than 2× is meaningless", () => {
    expect(checkSalary({ ...salary, min: 1, max: 10_000_000 })).toMatch(
      /too wide/
    )
    expect(checkSalary({ ...salary, min: 100_000, max: 200_001 })).toMatch(
      /at most 2× the minimum \(200000\)/
    )
  })
  test("currency is an ISO 4217 code, upper case", () => {
    expect(checkSalary({ ...salary, currency: "XYZ" })).toMatch(
      /Unknown currency "XYZ"/
    )
    expect(checkSalary({ ...salary, currency: "usd" })).toMatch(/Unknown/)
    expect(checkSalary({ ...salary, currency: "BTC" })).toMatch(/Unknown/)
    expect(checkSalary({ ...salary, currency: "XAU" })).toMatch(/Unknown/)
    for (const c of ["EUR", "JPY", "AED", "XOF", "XCG"])
      expect(checkSalary({ ...salary, currency: c })).toBeUndefined()
    expect(CURRENCIES.size).toBeGreaterThan(150)
  })
  test("period is one of the known values", () => {
    expect(checkSalary({ ...salary, period: "fortnight" })).toMatch(
      /Unknown pay period "fortnight"/
    )
  })
  test("reports every issue with the field it belongs to", () => {
    expect(
      salaryIssues({ min: 0, max: 5, currency: "ABC", period: "decade" }).map(
        (i) => i.field
      )
    ).toEqual(["min", "currency", "period"])
  })
  test("annualises with stated full-time assumptions", () => {
    expect(annualize(50, "hour")).toBe(104_000)
    expect(annualize(400, "day")).toBe(104_000)
    expect(annualize(2000, "week")).toBe(104_000)
    expect(annualize(8000, "month")).toBe(96_000)
    expect(annualize(100_000, "year")).toBe(100_000)
  })
  test("formats with the currency code", () => {
    expect(formatSalary(salary)).toBe("USD 100,000–150,000 a year")
    expect(formatSalary({ ...salary, min: 40, max: 40, period: "hour" })).toBe(
      "USD 40 an hour"
    )
  })
})

describe("posting rules", () => {
  const posting = { title: "SRE", organization: "Acme", salary }
  test("valid", () => expect(checkPosting(posting)).toBeUndefined())
  test("blank title or organization", () => {
    expect(checkPosting({ ...posting, title: "  " })).toBe("title is blank")
    expect(checkPosting({ ...posting, organization: "" })).toBe(
      "organization is blank"
    )
  })
  test("salary rules apply", () => {
    expect(checkPosting({ ...posting, salary: undefined })).toMatch(/required/)
  })
  test("close date is a real YYYY-MM-DD date", () => {
    expect(checkCloseDate("2026-10-31")).toBeUndefined()
    expect(checkCloseDate("2026-02-30")).toMatch(/YYYY-MM-DD/)
    expect(checkCloseDate("31/10/2026")).toMatch(/YYYY-MM-DD/)
    expect(checkCloseDate("2026-10")).toMatch(/YYYY-MM-DD/)
  })
  test("a posting closes when its date has ended everywhere on Earth", () => {
    expect(closesAt("2026-10-31")?.toISOString()).toBe(
      "2026-11-01T12:00:00.000Z"
    )
    expect(closesAt("2026-12-31")?.toISOString()).toBe(
      "2027-01-01T12:00:00.000Z"
    )
    expect(closesAt(undefined)).toBeUndefined()
  })
  test("apply links are http(s) or mailto", () => {
    expect(checkApplyUrl("https://example.com/apply")).toBeUndefined()
    expect(checkApplyUrl("mailto:jobs@example.com")).toBeUndefined()
    expect(checkApplyUrl("javascript:alert(1)")).toMatch(/http/)
  })
})

describe("protected wording in job postings", () => {
  test("job-ad phrases are removed from job documents", () => {
    expect(
      redactJobText(
        "Join our young, energetic team. Native English speaker preferred; recent graduates welcome."
      )
    ).toBe("Join our, team. preferred; welcome.")
  })
  test("a line left with only punctuation is dropped", () => {
    expect(
      redactJobText(
        "Run the on-call rotation.\nYoung, energetic, native English speaker."
      )
    ).toBe("Run the on-call rotation.")
  })
  test("language requirements that are job-related stay", () => {
    expect(redactJobText("Fluent English and working Portuguese.")).toBe(
      "Fluent English and working Portuguese."
    )
  })
  test("the job-ad list does not touch profile redaction or queries", () => {
    const text = "Energetic native English speaker"
    expect(redactDocument(text)).toBe(text)
    expect(stripQuery(text).text).toBe(text)
    expect(stripJobQuery(text)).toEqual({
      text: "",
      removed: ["energetic", "native english speaker"],
    })
  })
  test("flags protected wording for the poster, but not plain years", () => {
    expect(
      findProtectedTerms(
        "Starts in 2027. We want a young, energetic salesman; he/him; native English speaker, under 30."
      )
    ).toEqual([
      "young",
      "energetic",
      "he/him",
      "native english speaker",
      "under 30",
    ])
    expect(findProtectedTerms("Kubernetes, Terraform, over 5 years")).toEqual(
      []
    )
  })
})
