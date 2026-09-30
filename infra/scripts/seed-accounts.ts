/**
 * Creates demo accounts on the local PDS. Idempotent: existing handles are
 * skipped. Every account uses the password `password`.
 *
 * It also writes alice.test's profile record, the one phase 2 wrote through
 * the editor by hand. Phases 5–8 measured search, match bands and feeds with
 * it in the index, so a clean start needs it back to reproduce them. It is
 * only rewritten when it differs.
 *
 *   bun run seed              # all accounts
 *   bun run seed -- --count 5
 */
import { join } from "node:path"
import { sh } from "@workspace/lexicons"

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2583"
const PASSWORD = "password"

const NAMES = [
  "alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi",
  "ivan", "judy", "mallory", "niaj", "olivia", "peggy", "rupert", "sybil",
  "trent", "victor", "walter", "yasmin", "zaid", "layla", "omar", "noor",
]

const countArg = process.argv.indexOf("--count")
const count =
  countArg > -1 ? Number(process.argv[countArg + 1]) : NAMES.length

type Account = { handle: string; did: string; created: boolean }

async function xrpc<T>(
  method: string,
  init?: { params?: Record<string, string>; body?: unknown }
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const url = new URL(`/xrpc/${method}`, PDS_URL)
  for (const [k, v] of Object.entries(init?.params ?? {})) {
    url.searchParams.set(k, v)
  }
  const res = await fetch(url, {
    method: init?.body ? "POST" : "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: String(json.message ?? json.error ?? res.statusText),
    }
  }
  return { ok: true, data: json as T }
}

const accounts: Account[] = []

for (const name of NAMES.slice(0, count)) {
  const handle = `${name}.test`

  const existing = await xrpc<{ did: string }>(
    "com.atproto.identity.resolveHandle",
    { params: { handle } }
  )
  if (existing.ok) {
    accounts.push({ handle, did: existing.data.did, created: false })
    console.log(`• ${handle.padEnd(16)} ${existing.data.did} (exists)`)
    continue
  }

  const created = await xrpc<{ did: string }>(
    "com.atproto.server.createAccount",
    { body: { handle, email: `${name}@authentiq.test`, password: PASSWORD } }
  )
  if (!created.ok) {
    console.error(`✗ ${handle}: ${created.status} ${created.error}`)
    process.exitCode = 1
    continue
  }
  accounts.push({ handle, did: created.data.did, created: true })
  console.log(`✓ ${handle.padEnd(16)} ${created.data.did}`)
}

// --- alice.test's profile, as phase 2 left it ------------------------------------

const ALICE_PROFILE = sh.authentiq.actor.profile.$parse({
  $type: sh.authentiq.actor.profile.$type,
  displayName: "Alice Anderson",
  headline: "Backend engineer — distributed systems",
  about: "I build boring infrastructure that stays up.",
  location: "Amman, JO",
  openToWork: true,
  skills: ["TypeScript", "Postgres", "AT Protocol"],
  createdAt: "2026-09-20T00:00:00.000Z",
})

if (accounts.some((a) => a.handle === "alice.test")) {
  const login = await xrpc<{ did: string; accessJwt: string }>(
    "com.atproto.server.createSession",
    { body: { identifier: "alice.test", password: PASSWORD } }
  )
  if (!login.ok) {
    console.error(`✗ alice.test: ${login.status} ${login.error}`)
    process.exitCode = 1
  } else {
    const current = await xrpc<{ value: unknown }>("com.atproto.repo.getRecord", {
      params: {
        repo: login.data.did,
        collection: sh.authentiq.actor.profile.$nsid,
        rkey: "self",
      },
    })
    const canonical = (v: unknown): string =>
      JSON.stringify(v, (_, x: unknown) =>
        x && typeof x === "object" && !Array.isArray(x)
          ? Object.fromEntries(
              Object.entries(x).sort(([a], [b]) => a.localeCompare(b))
            )
          : x
      )
    if (current.ok && canonical(current.data.value) === canonical(ALICE_PROFILE)) {
      console.log("• alice.test profile (up to date)")
    } else {
      const res = await fetch(new URL("/xrpc/com.atproto.repo.putRecord", PDS_URL), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${login.data.accessJwt}`,
        },
        body: JSON.stringify({
          repo: login.data.did,
          collection: sh.authentiq.actor.profile.$nsid,
          rkey: "self",
          record: ALICE_PROFILE,
        }),
      })
      if (!res.ok) {
        console.error(`✗ alice.test profile: ${res.status} ${await res.text()}`)
        process.exitCode = 1
      } else {
        console.log("✓ alice.test profile written")
      }
    }
  }
}

const out = join(import.meta.dir, "..", "seed", "accounts.json")
await Bun.write(out, JSON.stringify(accounts, null, 2) + "\n")
console.log(
  `\n${accounts.filter((a) => a.created).length} created, ` +
    `${accounts.filter((a) => !a.created).length} existing → infra/seed/accounts.json`
)
