import { isValidTid } from "@workspace/atproto"

/**
 * Synthetic job postings for phase 7 (`bun run seed:jobs`, `verify:jobs`).
 * Every employer, role and figure is invented. The posters are the demo
 * accounts from `bun run seed` and a few recruiters from the talent corpus.
 *
 * The valid postings cover several currencies (USD, EUR, GBP, AED, PLN, INR,
 * JPY, CAD, CHF, SGD, BRL), every pay period, onsite/hybrid/remote and every
 * seniority level. Most sit in a field of the talent corpus
 * (`field`), so "similar candidates" can be checked against it: the corpus
 * says which field each tal-NNN person is in.
 *
 * `invalid` postings are written raw, straight to the PDS, and each breaks
 * one salary-transparency rule. The PDS stores them (it has no schema for
 * our lexicons); the AppView must never index them.
 */

export type SeedPosting = {
  key: string
  by: string
  /** Talent corpus field the role belongs to, for similar-candidate checks. */
  field?: string
  record: Record<string, unknown>
  /** Why the AppView must drop it; absent for valid postings. */
  invalid?: string
}

const salary = (
  min: number,
  max: number,
  currency: string,
  period: string
) => ({
  min,
  max,
  currency,
  period,
})

export const POSTINGS: Array<SeedPosting> = [
  {
    key: "sre-kestrel",
    by: "alice.test",
    field: "sre",
    record: {
      title: "Senior Site Reliability Engineer",
      organization: "Kestrel Cloud",
      description:
        "Keep a payments platform up. You will share the on-call rotation, run incident reviews that end in fixes rather than blame, and turn our alerting into SLOs people trust. Most of the platform is Kubernetes on AWS, managed with Terraform; Prometheus and Grafana for metrics.",
      location: "Anywhere in Europe",
      locationType: "remote",
      employmentType: "full-time",
      skills: ["Kubernetes", "Terraform", "Prometheus", "Incident response"],
      salary: salary(150_000, 190_000, "USD", "year"),
      applyUrl: "https://example.com/kestrel/sre",
    },
  },
  {
    key: "dataeng-lumenfield",
    by: "tal-075.test",
    field: "dataeng",
    record: {
      title: "Data Engineer",
      organization: "Lumenfield Analytics",
      description:
        "Build and run the pipelines that feed our warehouse: batch ingestion with Airflow, models in dbt with tests on every one, and Snowflake cost control. You will work with analysts to make data they can trust.",
      location: "Bengaluru, India",
      locationType: "hybrid",
      employmentType: "full-time",
      skills: ["SQL", "dbt", "Airflow", "Snowflake"],
      salary: salary(2_400_000, 3_600_000, "INR", "year"),
    },
  },
  {
    key: "ds-northwind",
    by: "tal-073.test",
    field: "datascience",
    record: {
      title: "Data Scientist, Customer Retention",
      organization: "Northwind Telecom",
      description:
        "Predict which customers are about to cancel and work out what keeps them. You will build churn models in Python, design A/B tests with the product team, and get models into production with monitoring for drift.",
      location: "Amsterdam, Netherlands",
      locationType: "hybrid",
      employmentType: "full-time",
      skills: ["Python", "Machine learning", "A/B testing", "scikit-learn"],
      salary: salary(70_000, 90_000, "EUR", "year"),
    },
  },
  {
    key: "teacher-alnoor",
    by: "layla.test",
    field: "teaching",
    record: {
      title: "Mathematics Teacher (Secondary)",
      organization: "Al Noor International School",
      description:
        "Teach mathematics across secondary years 7 to 13, plan lessons and assessments for the IGCSE and A-level courses, and help run the after-school maths club.",
      location: "Dubai, UAE",
      locationType: "onsite",
      employmentType: "full-time",
      skills: ["Mathematics", "Lesson planning", "Assessment"],
      salary: salary(14_000, 18_000, "AED", "month"),
      closeDate: "2030-06-30",
    },
  },
  {
    key: "frontend-junior-canopy",
    by: "bob.test",
    field: "frontend",
    record: {
      title: "Junior Frontend Developer",
      organization: "Canopy Commerce",
      description:
        "Your first or second frontend role. You will build accessible React components with TypeScript, pair with senior engineers every week, and ship to production from your first month.",
      location: "Toronto, Canada",
      locationType: "remote",
      employmentType: "contract",
      skills: ["React", "TypeScript", "CSS", "Accessibility"],
      salary: salary(35, 45, "USD", "hour"),
    },
  },
  {
    key: "nurse-stmargaret",
    by: "tal-074.test",
    field: "nursing",
    record: {
      title: "Critical Care Staff Nurse",
      organization: "St Margaret's Hospital",
      description:
        "Care for critically ill patients in a 16-bed intensive care unit: assessment, ventilator care and working closely with the medical team on twelve-hour shifts.",
      location: "London, UK",
      locationType: "onsite",
      employmentType: "full-time",
      skills: ["Patient care", "Clinical assessment", "ICU"],
      salary: salary(24, 30, "GBP", "hour"),
    },
  },
  {
    key: "backend-tulipay",
    by: "tal-072.test",
    field: "backend",
    record: {
      title: "Backend Engineer (Go)",
      organization: "Tulipay",
      description:
        "Design the APIs behind our payouts: idempotent HTTP and gRPC services in Go, Postgres schema design, and Kafka for the event pipeline.",
      location: "Warsaw, Poland",
      locationType: "hybrid",
      employmentType: "full-time",
      skills: ["Go", "PostgreSQL", "Kafka", "gRPC"],
      salary: salary(18_000, 25_000, "PLN", "month"),
    },
  },
  {
    key: "design-harbour",
    by: "tal-071.test",
    field: "design",
    record: {
      title: "Product Designer",
      organization: "Harbour Health",
      description:
        "Make our patient app's screens clear and easy to use. You will run user research, prototype in Figma, and look after our design system with the frontend team.",
      location: "Lisbon, Portugal",
      locationType: "remote",
      employmentType: "full-time",
      skills: ["Figma", "User research", "Prototyping", "Design systems"],
      salary: salary(5_500, 7_000, "EUR", "month"),
    },
  },
  {
    key: "mecheng-nagoya",
    by: "noor.test",
    field: "mecheng",
    record: {
      title: "Mechanical Design Engineer",
      organization: "Kisaragi Motors",
      description:
        "Design machined and sheet-metal parts for our assembly lines in SolidWorks, run tolerance analysis with GD&T, and get parts ready for the factory with our suppliers.",
      location: "Nagoya, Japan",
      locationType: "onsite",
      employmentType: "full-time",
      skills: ["SolidWorks", "Mechanical design", "GD&T"],
      salary: salary(6_000_000, 9_000_000, "JPY", "year"),
    },
  },
  {
    key: "sales-maple",
    by: "tal-075.test",
    field: "sales",
    record: {
      title: "Account Executive, Mid-Market",
      organization: "Maplestack Software",
      description:
        "Own a book of mid-market accounts from first call to signature: discovery, demos, negotiating contracts and forecasting in Salesforce.",
      location: "Toronto, Canada",
      locationType: "hybrid",
      employmentType: "full-time",
      skills: ["B2B sales", "Salesforce", "Negotiation"],
      salary: salary(75_000, 110_000, "CAD", "year"),
    },
  },
  {
    key: "recruiter-contract",
    by: "alice.test",
    field: "recruiting",
    record: {
      title: "Technical Recruiter (6-month contract)",
      organization: "Kestrel Cloud",
      description:
        "Hire engineers for our platform and payments teams: sourcing, screening calls, running structured interviews and closing offers. We publish the salary range on every role.",
      location: "United Kingdom",
      locationType: "remote",
      employmentType: "contract",
      skills: ["Technical recruiting", "Sourcing", "Interviewing"],
      salary: salary(900, 1_200, "GBP", "week"),
    },
  },
  {
    key: "legal-zurich",
    by: "tal-073.test",
    field: "legal",
    record: {
      title: "Senior Commercial Counsel",
      organization: "Alpenrose Systems",
      description:
        "Negotiate and draft commercial contracts for a software company: customer agreements, data processing terms and partner deals.",
      location: "Zurich, Switzerland",
      locationType: "hybrid",
      employmentType: "full-time",
      skills: ["Contract negotiation", "Commercial law", "SaaS"],
      salary: salary(140_000, 180_000, "CHF", "year"),
    },
  },
  {
    key: "finance-sg",
    by: "omar.test",
    field: "finance",
    record: {
      title: "Financial Controller",
      organization: "Straits Freight",
      description:
        "Run the month-end close, own financial reporting under IFRS, and work with auditors and the CFO on the annual accounts.",
      location: "Singapore",
      locationType: "onsite",
      employmentType: "full-time",
      skills: ["Month-end close", "Financial reporting", "IFRS"],
      salary: salary(9_000, 12_000, "SGD", "month"),
    },
  },
  {
    key: "marketing-sp",
    by: "tal-072.test",
    field: "marketing",
    record: {
      title: "SEO and Content Lead",
      organization: "Cafezal",
      description:
        "Grow our organic traffic: technical SEO, a content calendar, and writers who explain coffee better than anyone.",
      location: "São Paulo, Brazil",
      locationType: "remote",
      employmentType: "full-time",
      skills: ["SEO", "Content marketing", "Analytics"],
      salary: salary(12_000, 18_000, "BRL", "month"),
    },
  },
  {
    key: "pm-intern",
    by: "bob.test",
    field: "pm",
    record: {
      title: "Product Management Intern",
      organization: "Canopy Commerce",
      description:
        "Twelve weeks working with a product manager on discovery interviews, a roadmap and one feature from idea to launch.",
      location: "Toronto, Canada",
      locationType: "onsite",
      employmentType: "internship",
      skills: ["Product strategy", "User research"],
      salary: salary(160, 200, "CAD", "day"),
    },
  },
  {
    // Protected wording on purpose: the author is shown what the matcher
    // ignores, and the words have no effect on matching.
    key: "mobile-wording",
    by: "bob.test",
    field: "mobile",
    record: {
      title: "iOS Developer",
      organization: "Canopy Commerce",
      description:
        "Build our shopping app in Swift and SwiftUI with a small product team.\nWe are a young, energetic team and want a native English speaker.",
      location: "Toronto, Canada",
      locationType: "hybrid",
      employmentType: "full-time",
      skills: ["Swift", "SwiftUI", "iOS"],
      salary: salary(95_000, 125_000, "CAD", "year"),
    },
  },
  {
    // Closed: its date is in the past, so it is indexed but not on the board.
    key: "closed-support",
    by: "dave.test",
    record: {
      title: "Seasonal Support Engineer",
      organization: "Winterline Games",
      description: "Answer player tickets during our winter launch.",
      location: "Madrid, Spain",
      locationType: "remote",
      employmentType: "contract",
      skills: ["Customer support"],
      salary: salary(2_000, 2_400, "EUR", "month"),
      closeDate: "2026-06-30",
    },
  },

  // --- deliberately invalid: stored by the PDS, dropped by the AppView ---------
  {
    key: "bad-no-salary",
    by: "carol.test",
    invalid: "no salary",
    record: {
      title: "Office Manager",
      organization: "Quietwater Studio",
      description: "Salary: competitive. (No range given.)",
      locationType: "onsite",
    },
  },
  {
    key: "bad-min-over-max",
    by: "dave.test",
    invalid: "min > max",
    record: {
      title: "QA Engineer",
      organization: "Winterline Games",
      salary: salary(90_000, 60_000, "EUR", "year"),
    },
  },
  {
    key: "bad-spread",
    by: "dave.test",
    invalid: "spread over the 2× limit",
    record: {
      title: "Software Engineer (all levels)",
      organization: "Winterline Games",
      salary: salary(30_000, 150_000, "EUR", "year"),
    },
  },
  {
    key: "bad-currency",
    by: "carol.test",
    invalid: "unknown currency",
    record: {
      title: "Smart Contract Developer",
      organization: "Quietwater Studio",
      salary: salary(80_000, 100_000, "BTC", "year"),
    },
  },
  {
    key: "bad-zero-min",
    by: "omar.test",
    invalid: "zero minimum",
    record: {
      title: "Growth Hacker",
      organization: "Straits Freight",
      salary: salary(0, 120_000, "SGD", "year"),
    },
  },
  {
    key: "bad-period",
    by: "noor.test",
    invalid: "unknown period",
    record: {
      title: "Translator",
      organization: "Kisaragi Motors",
      salary: salary(300_000, 400_000, "JPY", "fortnight"),
    },
  },
  {
    key: "bad-no-currency",
    by: "layla.test",
    invalid: "salary missing currency",
    record: {
      title: "Payments Engineer",
      organization: "Dune Pay",
      salary: { min: 25_000, max: 32_000, period: "month" },
    },
  },
]

/** Each posting's fixed createdAt: one hour apart, from 2026-09-22 09:00 UTC. */
export const createdAtOf = (index: number) =>
  new Date(
    Date.parse("2026-09-22T09:00:00.000Z") + index * 3600_000
  ).toISOString()

/** Base32-sortable TID from a timestamp, so record keys never change. */
const B32 = "234567abcdefghijklmnopqrstuvwxyz"
function tid(micros: bigint) {
  let v = micros << 10n
  let s = ""
  for (let i = 0; i < 13; i++) {
    s = B32[Number(v & 31n)] + s
    v >>= 5n
  }
  if (!isValidTid(s)) throw new Error(`bad tid ${s}`)
  return s
}

/** Each posting's record key, derived from its createdAt. */
export const rkeyOf = (index: number) =>
  tid(BigInt(Date.parse(createdAtOf(index))) * 1000n)
