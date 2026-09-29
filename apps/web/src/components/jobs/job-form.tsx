import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@workspace/ui/components/native-select"
import { Textarea } from "@workspace/ui/components/textarea"
import { findProtectedTerms } from "@workspace/rules/protected"
import {
  COMMON_CURRENCIES,
  CURRENCIES,
  MAX_SPREAD,
  PERIODS_PER_YEAR,
  SALARY_PERIODS,
  annualize,
  isSalaryPeriod,
  salaryIssues,
} from "@workspace/rules/salary"
import { useMemo, useState } from "react"
import { EMPLOYMENT_LABEL, LOCATION_LABEL, PERIOD_NAME } from "./labels.ts"

export type JobFormValues = {
  title: string
  organization: string
  description: string
  location: string
  locationType: string
  employmentType: string
  skills: string
  salaryMin: string
  salaryMax: string
  currency: string
  period: string
  applyUrl: string
  closeDate: string
}

export const EMPTY_JOB: JobFormValues = {
  title: "",
  organization: "",
  description: "",
  location: "",
  locationType: "",
  employmentType: "full-time",
  skills: "",
  salaryMin: "",
  salaryMax: "",
  currency: "USD",
  period: "year",
  applyUrl: "",
  closeDate: "",
}

type Issue = { path: string; message: string }

const toNumber = (v: string) => (v.trim() === "" ? undefined : Number(v))

/**
 * The posting form, for new postings and edits. Salary problems are shown as
 * they are typed, from the same rules the AppView enforces
 * (@workspace/rules/salary), and the server checks again before writing.
 * Protected wording is flagged, not blocked: it is ignored for matching.
 */
export function JobForm(props: {
  initial: JobFormValues
  /** Set for an edit: the posting being replaced. */
  uri?: string
  onSaved: (uri: string) => void
}) {
  const [v, setV] = useState(props.initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverIssues, setServerIssues] = useState<Array<Issue>>([])
  const [tried, setTried] = useState(false)
  const set = (k: keyof JobFormValues) => (value: string) =>
    setV((old) => ({ ...old, [k]: value }))

  const salary = {
    min: toNumber(v.salaryMin),
    max: toNumber(v.salaryMax),
    currency: v.currency.trim().toUpperCase(),
    period: v.period,
  }
  const issues = salaryIssues(salary)
  const touched = tried || (v.salaryMin !== "" && v.salaryMax !== "")
  const salaryError = (field: string) =>
    (touched ? issues.find((i) => i.field === field)?.message : undefined) ??
    serverIssues.find((i) => i.path === `salary.${field}`)?.message
  const fieldError = (path: string) =>
    serverIssues.find((i) => i.path === path)?.message

  const flagged = useMemo(
    () =>
      findProtectedTerms(
        [v.title, v.description, v.skills].filter(Boolean).join("\n")
      ),
    [v.title, v.description, v.skills]
  )

  const perYear =
    issues.length === 0 &&
    isSalaryPeriod(salary.period) &&
    salary.period !== "year"
      ? `≈ ${salary.currency} ${annualize(salary.min!, salary.period).toLocaleString("en")}–${annualize(salary.max!, salary.period).toLocaleString("en")} a year, assuming full time (${PERIODS_PER_YEAR[salary.period]} ${PERIOD_NAME[salary.period]}s)`
      : undefined

  function submit() {
    setTried(true)
    if (issues.length > 0) {
      setError("Fix the salary range first: every posting states what it pays.")
      return
    }
    setBusy(true)
    setError(null)
    setServerIssues([])
    const body = {
      ...(props.uri ? { uri: props.uri } : {}),
      title: v.title,
      organization: v.organization,
      description: v.description,
      location: v.location,
      locationType: v.locationType || undefined,
      employmentType: v.employmentType || undefined,
      skills: v.skills,
      salary: {
        min: v.salaryMin,
        max: v.salaryMax,
        currency: v.currency,
        period: v.period,
      },
      applyUrl: v.applyUrl,
      closeDate: v.closeDate,
    }
    fetch(props.uri ? "/api/jobs/update" : "/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as {
          uri?: string
          message?: string
          issues?: Array<Issue>
        }
        if (!res.ok || !json.uri) {
          setServerIssues(json.issues ?? [])
          throw new Error(json.message ?? `Could not save (${res.status})`)
        }
        props.onSaved(json.uri)
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not save")
      )
      .finally(() => setBusy(false))
  }

  return (
    <form
      className="grid gap-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" id="title" error={fieldError("title")}>
          <Input
            id="title"
            value={v.title}
            onChange={(e) => set("title")(e.target.value)}
            maxLength={100}
            required
            dir="auto"
          />
        </Field>
        <Field
          label="Organization"
          id="organization"
          error={fieldError("organization")}
        >
          <Input
            id="organization"
            value={v.organization}
            onChange={(e) => set("organization")(e.target.value)}
            maxLength={100}
            required
            dir="auto"
          />
        </Field>
      </div>

      <fieldset
        className="grid gap-3 rounded-lg border p-4"
        data-testid="salary-fields"
      >
        <legend className="px-1 text-sm font-medium">
          Salary range (required)
        </legend>
        <p className="text-xs text-muted-foreground">
          Whole amounts, no cents. The maximum can be at most {MAX_SPREAD}× the
          minimum: a range that wide or wider says nothing about the pay.
        </p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Minimum" id="salaryMin" error={salaryError("min")}>
            <Input
              id="salaryMin"
              inputMode="numeric"
              value={v.salaryMin}
              onChange={(e) => set("salaryMin")(e.target.value)}
              aria-invalid={Boolean(salaryError("min"))}
            />
          </Field>
          <Field label="Maximum" id="salaryMax" error={salaryError("max")}>
            <Input
              id="salaryMax"
              inputMode="numeric"
              value={v.salaryMax}
              onChange={(e) => set("salaryMax")(e.target.value)}
              aria-invalid={Boolean(salaryError("max"))}
            />
          </Field>
          <Field label="Currency" id="currency" error={salaryError("currency")}>
            <NativeSelect
              id="currency"
              className="w-full"
              value={v.currency}
              onChange={(e) => set("currency")(e.target.value)}
            >
              <NativeSelectOptGroup label="Common">
                {COMMON_CURRENCIES.map((c) => (
                  <NativeSelectOption key={c} value={c}>
                    {c}
                  </NativeSelectOption>
                ))}
              </NativeSelectOptGroup>
              <NativeSelectOptGroup label="All ISO 4217">
                {[...CURRENCIES]
                  .filter(
                    (c) =>
                      !(COMMON_CURRENCIES as ReadonlyArray<string>).includes(c)
                  )
                  .map((c) => (
                    <NativeSelectOption key={c} value={c}>
                      {c}
                    </NativeSelectOption>
                  ))}
              </NativeSelectOptGroup>
            </NativeSelect>
          </Field>
          <Field label="Per" id="period" error={salaryError("period")}>
            <NativeSelect
              id="period"
              className="w-full"
              value={v.period}
              onChange={(e) => set("period")(e.target.value)}
            >
              {SALARY_PERIODS.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {PERIOD_NAME[p]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
        {touched && issues.some((i) => i.field === "salary") ? (
          <p className="text-sm text-destructive">{issues[0]?.message}</p>
        ) : null}
        {perYear ? (
          <p className="text-xs text-muted-foreground">{perYear}</p>
        ) : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Location" id="location" error={fieldError("location")}>
          <Input
            id="location"
            value={v.location}
            onChange={(e) => set("location")(e.target.value)}
            maxLength={100}
            placeholder="e.g. Lisbon, Portugal"
            dir="auto"
          />
        </Field>
        <Field label="Workplace" id="locationType">
          <NativeSelect
            id="locationType"
            className="w-full"
            value={v.locationType}
            onChange={(e) => set("locationType")(e.target.value)}
          >
            <NativeSelectOption value="">Not stated</NativeSelectOption>
            {Object.entries(LOCATION_LABEL).map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Employment" id="employmentType">
          <NativeSelect
            id="employmentType"
            className="w-full"
            value={v.employmentType}
            onChange={(e) => set("employmentType")(e.target.value)}
          >
            <NativeSelectOption value="">Not stated</NativeSelectOption>
            {Object.entries(EMPLOYMENT_LABEL).map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <Field
        label="Skills (comma-separated)"
        id="skills"
        error={fieldError("skills")}
      >
        <Input
          id="skills"
          value={v.skills}
          onChange={(e) => set("skills")(e.target.value)}
          placeholder="e.g. Kubernetes, Terraform"
        />
      </Field>

      <Field
        label="Description"
        id="description"
        error={fieldError("description")}
      >
        <Textarea
          id="description"
          rows={8}
          value={v.description}
          onChange={(e) => set("description")(e.target.value)}
          maxLength={5000}
          dir="auto"
        />
      </Field>

      {flagged.length > 0 ? (
        <Alert data-testid="protected-wording">
          <AlertTitle>Some wording will be ignored for matching</AlertTitle>
          <AlertDescription>
            <p>
              {flagged.map((t) => `“${t}”`).join(", ")}{" "}
              {flagged.length === 1 ? "refers" : "refer"} to age, gender,
              national origin or another protected attribute. Authentiq leaves
              {flagged.length === 1 ? " it" : " them"} out when matching people
              to this posting. Consider describing the job-related requirement
              instead, for example “fluent English” rather than “native
              speaker”.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Apply link (optional)"
          id="applyUrl"
          error={fieldError("applyUrl")}
        >
          <Input
            id="applyUrl"
            value={v.applyUrl}
            onChange={(e) => set("applyUrl")(e.target.value)}
            placeholder="https://… or mailto:…"
          />
        </Field>
        <Field
          label="Last day to apply (optional)"
          id="closeDate"
          error={fieldError("closeDate")}
        >
          <Input
            id="closeDate"
            type="date"
            value={v.closeDate}
            onChange={(e) => set("closeDate")(e.target.value)}
          />
        </Field>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy} className="justify-self-start">
        {busy ? "Saving…" : props.uri ? "Save changes" : "Post job"}
      </Button>
    </form>
  )
}

function Field(props: {
  label: string
  id: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      {props.error ? (
        <p className="text-xs text-destructive" data-error-for={props.id}>
          {props.error}
        </p>
      ) : null}
    </div>
  )
}
