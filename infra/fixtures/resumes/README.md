# Resume fixtures (phase 4 eval)

Synthetic resumes for `bun run eval:resume` and `bun run verify:resume`.
Every person and employer is invented. Some schools are real, so that the
non-English names are realistic. The files come from
`infra/scripts/gen-resume-fixtures.ts` (`bun run fixtures:resumes`). The
`*.expected.json` next to each file is written by hand, from the resume as a
reader sees it, not from parser output.

| File                          | What it tests                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `01-classic.pdf`              | Baseline single column, month dates, spoken languages next to skills          |
| `02-two-column.pdf`           | Sidebar + main column, drawn row by row, so the extracted text interleaves     |
| `03-no-dates.docx`            | No dates anywhere                                                              |
| `04-month-formats.docx`       | `October 2022`, `07/2019`, a season (`Summer 2018`), a graduation month only   |
| `05-current-role.pdf`         | Year-only dates, `now` for the current role, no summary                        |
| `06-career-gap.docx`          | A labelled career break between roles, a promotion at the same employer        |
| `07-non-english-schools.pdf`  | Spanish and French school names and titles, `actualidad` (Spanish "present")   |
| `08-cjk-school.docx`          | A Japanese school name, a German one, ISO `YYYY-MM` dates                      |
| `09-prompt-injection.pdf`     | Invisible (white, 4 pt) instructions telling the parser to add fake entries    |
| `10-contract-remote.pdf`      | Contract, part-time, freelance and volunteer roles; remote and hybrid          |
| `11-student.docx`             | No headline, an expected graduation date, internships                          |
| `12-promotions-terse.pdf`     | All-caps names, pipe-separated lines, three roles under one employer heading   |
| `13-table-layout.docx`        | Experience in a table, six roles, no descriptions                              |

## Annotation rules

The expected file has the parser's output shape (`sh.authentiq.resume.defs#draft`).
A field is present only when the resume states it.

- **Copy as written.** No translation, no expansion of abbreviations.
- **displayName**: the name as written. **headline**: the title line next to the
  name, if there is one. **about**: the summary / profile / objective paragraph.
  **location**: where the person is based, from the contact line.
- **skills**: items in a skills section. Spoken languages are not skills.
- **positions**: one per role, including several roles at one employer. A career
  break is not a position. `employmentType` and `locationType` only when the
  resume says so in words, including in the title ("Intern", "(part-time)").
  `description` is the role's bullets, one per line.
- **education**: the degree and the subject are split when the resume puts both
  in one phrase ("BSc Software Engineering" → degree `BSc`, field
  `Software Engineering`).
- **dates**: `YYYY-MM` when a month is written, `YYYY` when only a year is (a
  season is a year), absent when there is none. Present / now / actualidad
  means no `endDate`. A lone graduation date is an `endDate`.
