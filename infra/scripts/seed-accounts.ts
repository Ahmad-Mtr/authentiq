/**
 * Creates demo accounts on the local PDS. Idempotent: existing handles are
 * skipped. Every account uses the password `password`.
 *
 *   bun run seed              # all accounts
 *   bun run seed -- --count 5
 */
import { join } from "node:path"

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

const out = join(import.meta.dir, "..", "seed", "accounts.json")
await Bun.write(out, JSON.stringify(accounts, null, 2) + "\n")
console.log(
  `\n${accounts.filter((a) => a.created).length} created, ` +
    `${accounts.filter((a) => !a.created).length} existing → infra/seed/accounts.json`
)
