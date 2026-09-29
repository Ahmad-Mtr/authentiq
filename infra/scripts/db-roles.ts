/**
 * Creates (or updates) the read-only Postgres role the first-party feed
 * generator connects as (phase 8). Run by `bun run db:migrate`, after the
 * Drizzle migrations, because a role is cluster-wide and needs a password,
 * which cannot live in a migration file.
 *
 * `feedgen_reader` may log in and SELECT from the index tables listed below,
 * and nothing else: not the OAuth or web sessions, not resume drafts, not
 * pins or service state, and no writes anywhere (it has no write grants, and
 * its sessions default to read-only transactions as well). Moderation labels
 * are AppView private state, not index data, so they are not readable
 * either: the AppView applies them after hydration. A table a later
 * phase adds is invisible to it until it is added here.
 *
 * The password comes from `DATABASE_URL` in apps/feedgen/.env. An older
 * setup whose feedgen still connects as the `authentiq` owner gets a
 * generated password, and that one line of the (git-ignored) .env is
 * rewritten to use the new role. Idempotent.
 *
 *   bun run db:migrate
 */
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { SQL } from "bun"

const ROLE = "feedgen_reader"
/** What the feed generator reads: the public index, derived from repos. */
const READABLE = [
  "actor",
  "profile",
  "post",
  "follow",
  "community",
  "membership",
  "job_posting",
  "embedding",
]

const root = join(import.meta.dir, "..", "..")
const readEnv = async (path: string) =>
  Object.fromEntries(
    (await Bun.file(join(root, path)).text())
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  )
const infraEnv = await readEnv("infra/.env")
const feedgenEnvPath = join(root, "apps/feedgen/.env")
if (!existsSync(feedgenEnvPath)) {
  console.error("✗ apps/feedgen/.env is missing: run `bun run infra:env` first")
  process.exit(1)
}

// The password the feed generator will connect with.
const feedgenEnv = await Bun.file(feedgenEnvPath).text()
const line = feedgenEnv.split("\n").find((l) => l.startsWith("DATABASE_URL="))
let url = new URL(line ? line.slice("DATABASE_URL=".length) : "postgres://x@localhost/authentiq")
if (url.username !== ROLE || !url.password) {
  url = new URL(
    `postgres://${ROLE}:${randomBytes(16).toString("hex")}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`
  )
  const updated = line
    ? feedgenEnv.replace(line, `DATABASE_URL=${url}`)
    : `${feedgenEnv.trimEnd()}\nDATABASE_URL=${url}\n`
  await Bun.write(feedgenEnvPath, updated)
  console.log(`✓ apps/feedgen/.env now connects as ${ROLE} (restart the feedgen)`)
}
const password = decodeURIComponent(url.password)

const db = new SQL(
  `postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`
)
const quoted = password.replaceAll("'", "''")
const [exists] = await db`select 1 from pg_roles where rolname = ${ROLE}`
await db.unsafe(
  exists
    ? `alter role ${ROLE} with login password '${quoted}'`
    : `create role ${ROLE} with login password '${quoted}'`
)
await db.unsafe(`alter role ${ROLE} set default_transaction_read_only = on`)
await db.unsafe(`grant connect on database authentiq to ${ROLE}`)
await db.unsafe(`grant usage on schema public to ${ROLE}`)
// Exactly the listed tables: revoke first, so a table dropped from the list
// loses its grant too.
await db.unsafe(`revoke all on all tables in schema public from ${ROLE}`)
await db.unsafe(`grant select on ${READABLE.join(", ")} to ${ROLE}`)
await db.close()

console.log(
  `✓ role ${ROLE}: login, read-only, select on ${READABLE.length} tables (${READABLE.join(", ")})`
)
