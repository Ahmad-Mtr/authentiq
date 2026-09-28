/**
 * Smoke-checks the local network: PLC, PDS, Postgres (+pgvector), and the
 * services in apps/*. Exits non-zero if the infrastructure is unhealthy.
 *
 *   bun run infra:status
 */
import { join } from "node:path"
import { SQL } from "bun"

const env = Object.fromEntries(
  (await Bun.file(join(import.meta.dir, "..", ".env")).text())
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
)

let failed = false
const report = (ok: boolean, name: string, detail: string, required = true) => {
  if (!ok && required) failed = true
  console.log(`${ok ? "✓" : required ? "✗" : "–"} ${name.padEnd(10)} ${detail}`)
}

async function getJson(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<Record<string, unknown>>
}

try {
  await getJson("http://localhost:2582/_health")
  report(true, "plc", "http://localhost:2582")
} catch (e) {
  report(false, "plc", String(e))
}

try {
  const health = await getJson("http://localhost:2583/xrpc/_health")
  const repos = await getJson(
    "http://localhost:2583/xrpc/com.atproto.sync.listRepos?limit=100"
  )
  const count = (repos.repos as unknown[]).length
  report(true, "pds", `http://localhost:2583 v${health.version}, ${count} repos`)
} catch (e) {
  report(false, "pds", String(e))
}

try {
  const sql = new SQL(
    `postgres://authentiq:${env.POSTGRES_PASSWORD}@localhost:${env.POSTGRES_PORT ?? 5442}/authentiq`
  )
  const [row] = await sql`select extversion from pg_extension where extname = 'vector'`
  report(Boolean(row), "postgres", row ? `pgvector ${row.extversion}` : "pgvector missing")
  await sql.close()
} catch (e) {
  report(false, "postgres", String(e))
}

for (const [name, url] of [
  ["appview", "http://localhost:2584/xrpc/_health"],
  ["feedgen", "http://localhost:2585/xrpc/_health"],
] as const) {
  try {
    const health = await getJson(url)
    report(true, name, JSON.stringify(health))
  } catch {
    report(false, name, "not running (start with `bun run dev`)", false)
  }
}

try {
  const res = await fetch("http://127.0.0.1:3000/login", {
    signal: AbortSignal.timeout(5000),
  })
  report(res.ok, "web", "http://127.0.0.1:3000", false)
} catch {
  report(false, "web", "not running (start with `bun run dev`)", false)
}

process.exit(failed ? 1 : 0)
