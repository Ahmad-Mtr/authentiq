import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { z } from "zod"

export const Route = createFileRoute("/login")({
  validateSearch: z.object({
    error: z.string().optional(),
    mode: z.enum(["signin", "signup"]).optional(),
  }),
  component: Login,
})

function Login() {
  const { error, mode } = Route.useSearch()
  const signup = mode === "signup"

  return (
    <main className="mx-auto max-w-sm px-6 py-16">
      <h1 className="text-xl font-semibold">
        {signup ? "Create an account" : "Sign in"}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {signup
          ? "Creates an account on the local development PDS, then authorizes Authentiq."
          : "You authorize Authentiq on your own PDS. We never see your password."}
      </p>

      {error ? (
        <p className="border-destructive/50 text-destructive mt-4 rounded-md border px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      {signup ? (
        <form method="post" action="/api/auth/signup" className="mt-6 grid gap-4">
          <Field id="handle" label="Handle" placeholder="yourname.test" />
          <Field
            id="email"
            label="Email"
            type="email"
            placeholder="you@example.com"
          />
          <Field id="password" label="Password" type="password" />
          <Button type="submit">Create account</Button>
        </form>
      ) : (
        <form method="post" action="/api/oauth/login" className="mt-6 grid gap-4">
          <Field id="handle" label="Handle" placeholder="alice.test" />
          <Button type="submit">Continue</Button>
        </form>
      )}

      <p className="text-muted-foreground mt-6 text-sm">
        {signup ? (
          <a href="/login" className="underline">
            I already have an account
          </a>
        ) : (
          <a href="/login?mode=signup" className="underline">
            Create an account on this PDS
          </a>
        )}
      </p>
    </main>
  )
}

function Field({
  id,
  label,
  type = "text",
  placeholder,
}: {
  id: string
  label: string
  type?: string
  placeholder?: string
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} type={type} placeholder={placeholder} required />
    </div>
  )
}
