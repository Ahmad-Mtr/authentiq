/**
 * Writes the synthetic talent corpus (infra/fixtures/talent/corpus.ts) into
 * the local PDS: one account per person (`tal-NNN.test`, password
 * "password"), with their profile, positions and education as records. It
 * goes through the PDS, so it travels the real path:
 *
 *   PDS → firehose → indexer → embedding queue → worker → pgvector
 *
 * Idempotent, like `bun run seed`: record keys are deterministic TIDs, and a
 * repo that already matches is not written to at all. Then it waits (polling,
 * with a timeout) until every person is indexed and embedded.
 *
 *   bun run seed:talent
 */
import { join } from "node:path"
import { SQL } from "bun"
import { LOCAL_NETWORK, isValidTid } from "@workspace/atproto"
import { sh } from "@workspace/lexicons"
import { buildCorpus } from "../fixtures/talent/corpus.ts"
import type { Person } from "../fixtures/talent/corpus.ts"

const root = join(import.meta.dir, "..", "..")
const infraEnv = Object.fromEntries(
  (await Bun.file(join(root, "infra/.env")).text())
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
)
const PDS = process.env.PDS_URL ?? LOCAL_NETWORK.pdsUrl
const PASSWORD = "password"
const CREATED_AT = "2026-09-01T00:00:00.000Z"
const WAIT_MS = 180_000

async function xrpc(method: string, body: unknown, auth?: string) {
  const res = await fetch(new URL(`/xrpc/${method}`, PDS), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  })
  return {
    ok: res.ok,
    body: (await res.json().catch(() => ({}))) as Record<string, any>,
  }
}

/** Base32-sortable TID from a fixed timestamp, so record keys never change. */
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
const BASE_MICROS = BigInt(Date.parse(CREATED_AT)) * 1000n

/** The records a person's repo should hold, keyed by collection/rkey. */
function desired(p: Person, index: number) {
  const records = new Map<string, Record<string, unknown>>()
  records.set(
    `${sh.authentiq.actor.profile.$nsid}/self`,
    sh.authentiq.actor.profile.$parse({
      $type: sh.authentiq.actor.profile.$type,
      ...p.profile,
      createdAt: CREATED_AT,
    })
  )
  p.positions.forEach((pos, j) =>
    records.set(
      `${sh.authentiq.actor.position.$nsid}/${tid(BASE_MICROS + BigInt(index * 100 + j))}`,
      sh.authentiq.actor.position.$parse({
        $type: sh.authentiq.actor.position.$type,
        ...pos,
        createdAt: CREATED_AT,
      })
    )
  )
  p.education.forEach((edu, j) =>
    records.set(
      `${sh.authentiq.actor.education.$nsid}/${tid(BASE_MICROS + BigInt(index * 100 + 50 + j))}`,
      sh.authentiq.actor.education.$parse({
        $type: sh.authentiq.actor.education.$type,
        ...edu,
        createdAt: CREATED_AT,
      })
    )
  )
  return records
}

async function session(p: Person) {
  const created = await xrpc("com.atproto.server.createAccount", {
    handle: p.handle,
    email: `${p.handle.replace(".test", "")}@authentiq.test`,
    password: PASSWORD,
  })
  if (created.ok)
    return {
      did: created.body.did as string,
      jwt: created.body.accessJwt as string,
      created: true,
    }
  const s = await xrpc("com.atproto.server.createSession", {
    identifier: p.handle,
    password: PASSWORD,
  })
  if (!s.ok)
    throw new Error(`${p.handle}: ${created.body.message ?? s.body.message}`)
  return {
    did: s.body.did as string,
    jwt: s.body.accessJwt as string,
    created: false,
  }
}

async function current(did: string) {
  const out = new Map<string, unknown>()
  for (const nsid of [
    sh.authentiq.actor.profile.$nsid,
    sh.authentiq.actor.position.$nsid,
    sh.authentiq.actor.education.$nsid,
  ]) {
    const url = new URL("/xrpc/com.atproto.repo.listRecords", PDS)
    url.searchParams.set("repo", did)
    url.searchParams.set("collection", nsid)
    url.searchParams.set("limit", "100")
    const res = (await (await fetch(url)).json()) as {
      records?: Array<{ uri: string; value: unknown }>
    }
    for (const r of res.records ?? [])
      out.set(r.uri.split("/").slice(3).join("/"), r.value)
  }
  return out
}

/** Key order does not matter to a record, so compare canonical JSON. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b))
        )
      : x
  )

const people = buildCorpus()
let created = 0
let written = 0
let unchanged = 0
const dids: Array<string> = []

const queue = people.map((p, i) => [p, i] as const)
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [p, i] = item
      const s = await session(p)
      if (s.created) created++
      dids.push(s.did)
      const want = desired(p, i)
      const have = await current(s.did)
      const writes: Array<Record<string, unknown>> = []
      for (const [key, value] of want) {
        const [collection, rkey] = key.split("/") as [string, string]
        if (!have.has(key)) {
          writes.push({
            $type: "com.atproto.repo.applyWrites#create",
            collection,
            rkey,
            value,
          })
        } else if (canonical(have.get(key)) !== canonical(value)) {
          writes.push({
            $type: "com.atproto.repo.applyWrites#update",
            collection,
            rkey,
            value,
          })
        }
      }
      for (const key of have.keys()) {
        if (want.has(key)) continue
        const [collection, rkey] = key.split("/") as [string, string]
        writes.push({
          $type: "com.atproto.repo.applyWrites#delete",
          collection,
          rkey,
        })
      }
      if (writes.length === 0) {
        unchanged++
        continue
      }
      const res = await xrpc(
        "com.atproto.repo.applyWrites",
        { repo: s.did, writes },
        `Bearer ${s.jwt}`
      )
      if (!res.ok) throw new Error(`${p.handle}: ${res.body.message}`)
      written++
    }
  })
)
console.log(
  `✓ ${people.length} people: ${created} account(s) created, ${written} repo(s) written, ${unchanged} already up to date`
)

// Wait for the firehose → index → embedding path to catch up.
const db = new SQL(
  `postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`
)
const started = performance.now()
let last = ""
for (;;) {
  const [row] = await db`
    select
      (select count(*)::int from profile where did in ${db(dids)}) as indexed,
      (select count(*)::int from embedding
        where subject in ${db(dids)} and vector is not null
          and dirty_at is null and embedded_hash = content_hash) as embedded`
  const status = `${row.indexed}/${people.length} indexed, ${row.embedded}/${people.length} embedded`
  if (status !== last) console.log(`  ${status}`)
  last = status
  if (row.indexed === people.length && row.embedded === people.length) break
  if (performance.now() - started > WAIT_MS) {
    console.log(
      `✗ timed out after ${WAIT_MS / 1000} s — is the AppView running (bun run dev)?`
    )
    await db.close()
    process.exit(1)
  }
  await Bun.sleep(500)
}
await db.close()
console.log(
  `✓ corpus indexed and embedded (${Math.round(performance.now() - started)} ms)`
)
