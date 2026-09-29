import { describe, expect, test } from "bun:test"
import {
  JOB_DOCUMENT_VERSION,
  buildJobDocument,
  buildProfileDocument,
  hashDocument,
  seniorityOf,
} from "./document.ts"
import type { ProfileSource } from "./document.ts"
import { redactDocument, stripQuery } from "@workspace/rules/protected"

const source = (over: Partial<ProfileSource> = {}): ProfileSource => ({
  profile: {
    headline: "Senior Backend Engineer",
    about: "I build payment systems.",
    skills: ["Go", "PostgreSQL"],
  },
  positions: [
    {
      title: "Backend Engineer",
      organization: "Kestrel Logistics",
      startDate: "2017-06",
      endDate: "2021-02",
      description: "Built the route-pricing service.",
    },
    {
      title: "Senior Backend Engineer",
      organization: "Tulipay",
      startDate: "2021-03",
      employmentType: "full-time",
      skills: ["Kafka", "go"],
    },
  ],
  education: [
    { degree: "MSc", fieldOfStudy: "Computer Science", startDate: "2013" },
  ],
  ...over,
})

describe("buildProfileDocument", () => {
  test("lays out the profile, newest position first", () => {
    expect(buildProfileDocument(source())).toBe(
      [
        "Headline: Senior Backend Engineer",
        "About: I build payment systems.",
        "Skills: Go, PostgreSQL, Kafka",
        "Experience:",
        "- Senior Backend Engineer at Tulipay (current, full-time)",
        "- Backend Engineer at Kestrel Logistics. Built the route-pricing service.",
        "Education:",
        "- MSc in Computer Science",
      ].join("\n")
    )
  })

  test("no profile record, no document", () => {
    expect(buildProfileDocument(source({ profile: null }))).toBeNull()
  })

  test("never contains dates, even though they order the positions", () => {
    const doc = buildProfileDocument(source())!
    expect(doc).not.toMatch(/20\d\d|19\d\d/)
  })

  test("drops identifying and protected fields that are not in the input shape", () => {
    // The builder's input has no name, handle, avatar, school, location or
    // openToWork; extra fields on a row must not leak through.
    const withExtras = source()
    Object.assign(withExtras.profile!, {
      displayName: "Marisol Okonkwo",
      location: "Rotterdam",
      openToWork: true,
    })
    Object.assign(withExtras.education[0]!, {
      school: "Delft University of Technology",
    })
    const doc = buildProfileDocument(withExtras)!
    for (const s of ["Marisol", "Rotterdam", "Delft", "true"])
      expect(doc).not.toContain(s)
  })

  test("redacts ages, years, pronouns and protected terms from free text", () => {
    const doc = buildProfileDocument(
      source({
        profile: {
          headline: "Engineer (she/her)",
          about:
            "A 29-year-old Christian mother of two, coding since 2009. Proud woman in tech with over 10 years of experience.",
          skills: [],
        },
      })
    )!
    expect(doc).toContain("Headline: Engineer")
    for (const s of ["she/her", "29", "Christian", "mother", "2009", "woman"]) {
      expect(doc).not.toContain(s)
    }
    expect(doc).toContain("over 10 years of experience")
  })

  test("the same input gives the same document and hash", () => {
    const a = buildProfileDocument(source())!
    const b = buildProfileDocument(source())!
    expect(a).toBe(b)
    expect(hashDocument("m", a)).toBe(hashDocument("m", b))
    expect(hashDocument("m", a)).not.toBe(hashDocument("other-model", a))
  })

  test("position order does not depend on input order", () => {
    const s = source()
    const reversed = { ...s, positions: [...s.positions].reverse() }
    expect(buildProfileDocument(reversed)).toBe(buildProfileDocument(s))
  })
})

describe("protected terms", () => {
  test("stripQuery removes them and reports what it removed", () => {
    const { text, removed } = stripQuery(
      "young female backend engineers under 30"
    )
    expect(text).toBe("backend engineers")
    expect(removed.sort()).toEqual(["female", "under 30", "young"])
  })

  test("job vocabulary that merely contains or neighbours a term survives", () => {
    for (const phrase of [
      "black-box testing",
      "Six Sigma black belt",
      "senior engineer",
      "manager",
      "straight-through processing",
      "over 10 years of experience",
      "Kubernetes",
    ]) {
      expect(redactDocument(phrase)).toBe(phrase)
      expect(stripQuery(phrase).removed).toEqual([])
    }
  })

  test("years and stated ages go", () => {
    expect(
      redactDocument("Graduated 2012, aged 34, a 40-year-old in her 40s")
    ).toBe("Graduated, a in")
  })
})

describe("buildJobDocument (phase 7)", () => {
  const job = {
    title: "Senior Site Reliability Engineer",
    description: "Own the on-call rotation and our Terraform.",
    employmentType: "full-time",
    locationType: "remote",
    skills: ["Terraform", "Kubernetes", "terraform"],
  }

  test("lays out the work, with seniority read from the title", () => {
    expect(buildJobDocument(job)).toBe(
      [
        "Role: Senior Site Reliability Engineer",
        "Seniority: senior",
        "Type: full-time, remote",
        "Skills: Terraform, Kubernetes",
        "Description: Own the on-call rotation and our Terraform.",
      ].join("\n")
    )
  })

  test("protected wording cannot change the document", () => {
    const worded = {
      ...job,
      description: `${job.description}\nYoung, energetic, native English speaker.`,
    }
    expect(buildJobDocument(worded)).toBe(buildJobDocument(job))
  })

  test("seniority cues", () => {
    expect(seniorityOf("Staff Backend Engineer")).toBe("lead")
    expect(seniorityOf("Junior Frontend Developer")).toBe("junior")
    expect(seniorityOf("Software Engineering Intern")).toBe("internship")
    expect(seniorityOf("Sr. Accountant")).toBe("senior")
    expect(seniorityOf("Backend Engineer")).toBeUndefined()
  })

  test("job and profile documents hash with their own builder versions", () => {
    expect(hashDocument("m", "doc", JOB_DOCUMENT_VERSION + 1)).not.toBe(
      hashDocument("m", "doc")
    )
  })
})
