/**
 * End-to-end check of phase 5 embeddings and talent search, against the live
 * stack:
 *
 *   PDS write → firehose → index → embedding queue → worker → pgvector + FTS
 *   → sh.authentiq.actor.searchTalent
 *
 * Works on a throwaway account (`srch-….test`) that it deletes at the end,
 * plus the talent corpus for the filter checks (`bun run seed:talent`).
 * Needs ADMIN_TOKEN in apps/appview/.env: the outage check points the
 * embedding client at a dead URL through /_admin/embedder/endpoint, and puts
 * it back whatever happens.
 *
 *   bun run verify:search
 */
import { join } from "node:path"
import { SQL } from "bun"
import { LOCAL_NETWORK } from "@workspace/atproto"
import { sh } from "@workspace/lexicons"

const root = join(import.meta.dir, "..", "..")
const readEnv = async (path: string) =>
  Object.fromEntries(
    (await Bun.file(join(root, path)).text())
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  )
const infraEnv = await readEnv("infra/.env")
const appviewEnv = await readEnv("apps/appview/.env")

const PDS = process.env.PDS_URL ?? LOCAL_NETWORK.pdsUrl
const APPVIEW = process.env.APPVIEW_URL ?? LOCAL_NETWORK.appviewUrl
const ADMIN = `Bearer ${appviewEnv.ADMIN_TOKEN ?? ""}`
const PDS_ADMIN = `Basic ${btoa(`admin:${infraEnv.PDS_ADMIN_PASSWORD}`)}`
const TIMEOUT_MS = 30_000
const DEAD_URL = "http://127.0.0.1:9"

const db = new SQL(
  `postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`
)

let failures = 0
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
}
const section = (title: string) => console.log(`\n${title}`)

async function until<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeout = TIMEOUT_MS
) {
  const started = performance.now()
  while (performance.now() - started < timeout) {
    const value = await probe()
    if (value) return { value, ms: Math.round(performance.now() - started) }
    await Bun.sleep(100)
  }
  return { value: undefined, ms: timeout }
}
const took = (r: { value: unknown; ms: number }, timeout = TIMEOUT_MS) =>
  r.value ? `${r.ms} ms` : `timed out after ${timeout} ms`

async function xrpc(
  base: string,
  method: string,
  opts: {
    body?: unknown
    params?: Record<string, string | Array<string>>
    auth?: string
    post?: boolean
  } = {}
) {
  const url = new URL(`/xrpc/${method}`, base)
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    for (const x of [v].flat()) url.searchParams.append(k, x)
  }
  const res = await fetch(url, {
    method: opts.body === undefined && !opts.post ? "GET" : "POST",
    headers: {
      ...(opts.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, any>
  return { status: res.status, ok: res.ok, body }
}

type Result = {
  actor: {
    did: string
    handle: string
    location?: string
    openToWork?: boolean
  }
  matchedBy: Array<string>
}
/** searchTalent, waiting out the per-IP rate limit rather than failing on it. */
async function search(
  q: string,
  params: Record<string, string | Array<string>> = {}
) {
  for (let i = 0; ; i++) {
    const res = await xrpc(APPVIEW, "sh.authentiq.actor.searchTalent", {
      params: { q, ...params },
    })
    if (res.status === 429 && i < 60) {
      await Bun.sleep(1000)
      continue
    }
    return res.body as {
      results?: Array<Result>
      ignoredTerms?: Array<string>
      degraded?: boolean
    }
  }
}
const found = async (
  q: string,
  did: string,
  params: Record<string, string> = {}
) =>
  (await search(q, { limit: "10", ...params })).results?.some(
    (r) => r.actor.did === did
  ) ?? false

async function admin(path: string, body?: unknown) {
  const res = await fetch(new URL(`/_admin/${path}`, APPVIEW), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: ADMIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, any>,
  }
}

const embeddingRow = async (did: string) =>
  (
    await db`
      select document, content_hash, embedded_hash, embed_count, attempts, last_error,
             dirty_at, updated_at, embedded_at, vector is not null as has_vector
      from embedding where subject = ${did}`
  )[0] as
    | {
        document: string
        content_hash: string
        embedded_hash: string
        embed_count: number
        attempts: number
        last_error: string | null
        dirty_at: Date | null
        updated_at: Date
        embedded_at: Date | null
        has_vector: boolean
      }
    | undefined
const fresh = async (did: string) => {
  const row = await embeddingRow(did)
  return row?.has_vector &&
    !row.dirty_at &&
    row.content_hash === row.embedded_hash
    ? row
    : undefined
}

// --- 0. preconditions --------------------------------------------------------

const health = await xrpc(APPVIEW, "_health")
if (!health.ok) {
  console.log(
    `✗ AppView not reachable at ${APPVIEW} (start it with \`bun run dev\`)`
  )
  process.exit(1)
}
if ((await admin("embedder")).status !== 200) {
  console.log(
    "✗ /_admin/embedder refused — is ADMIN_TOKEN set in apps/appview/.env?"
  )
  process.exit(1)
}
const corpus = await xrpc(APPVIEW, "sh.authentiq.actor.getProfile", {
  params: { actor: "tal-001.test" },
})
if (!corpus.ok) {
  console.log("✗ talent corpus not indexed (run `bun run seed:talent`)")
  process.exit(1)
}

const suffix = Date.now().toString(36)
const handle = `srch-${suffix}.test`
const account = await xrpc(PDS, "com.atproto.server.createAccount", {
  body: {
    handle,
    email: `srch-${suffix}@authentiq.test`,
    password: "password",
  },
})
const did = account.body.did as string
const jwt = `Bearer ${account.body.accessJwt}`
check(account.ok, "throwaway account created on the PDS", `${handle} ${did}`)
if (!account.ok) process.exit(1)

const profile = (over: Record<string, unknown> = {}) => ({
  $type: sh.authentiq.actor.profile.$nsid,
  displayName: "Search Probe",
  headline: "Beekeeper and pollination contractor",
  about:
    "I manage two hundred beehives: queen rearing, varroa mite treatment, honey extraction, and renting colonies to orchards for pollination.",
  location: "Ghent, Belgium",
  openToWork: true,
  skills: ["Apiculture", "Queen rearing", "Varroa control"],
  createdAt: "2026-09-29T00:00:00.000Z",
  ...over,
})
const putProfile = (over: Record<string, unknown> = {}) =>
  xrpc(PDS, "com.atproto.repo.putRecord", {
    body: {
      repo: did,
      collection: sh.authentiq.actor.profile.$nsid,
      rkey: "self",
      record: profile(over),
    },
    auth: jwt,
  })
const actorRev = async () =>
  (await db`select rev from actor where did = ${did}`)[0]?.rev as
    string | undefined
/** Waits until the index has applied the commit at `rev`. */
const indexedRev = (rev: string) =>
  until(async () => ((await actorRev()) ?? "") >= rev)

const PARAPHRASE = "someone who looks after bee colonies and produces honey"

try {
  // --- 1. new profile → embedded → found by a paraphrase ---------------------
  section("1. write → embed → findable by a paraphrase")

  const first = await putProfile()
  const embedded = await until(() => fresh(did))
  check(
    first.ok && embedded.value?.embed_count === 1,
    "profile embedded after the firehose delivers it",
    took(embedded)
  )
  check(
    !/Search Probe|Ghent/.test(embedded.value?.document ?? ""),
    "document leaves out name and location",
    JSON.stringify(embedded.value?.document.split("\n")[0])
  )
  const byMeaning = await until(() =>
    found(PARAPHRASE, did, { mode: "vector" })
  )
  check(
    Boolean(byMeaning.value),
    "vector search finds it by paraphrase",
    `“${PARAPHRASE}”`
  )
  check(await found(PARAPHRASE, did), "hybrid search finds it too")

  // --- 2. re-embed only when the document changes ------------------------------
  section("2. re-embed only on a changed hash")

  const before = (await embeddingRow(did))!
  const edited = await putProfile({
    about:
      "I manage two hundred beehives and teach urban beekeeping courses: queen rearing, varroa treatment, honey extraction.",
  })
  const reembedded = await until(async () => {
    const row = await fresh(did)
    return row && row.embed_count === 2 && row
  })
  check(
    edited.ok &&
      Boolean(reembedded.value) &&
      reembedded.value!.embedded_hash !== before.embedded_hash,
    "editing the about text re-embeds (new hash, embed count 1 → 2)",
    took(reembedded)
  )

  const statsBefore = (await admin("embedder")).body
  const afterEdit = (await embeddingRow(did))!
  // Same document, different record: location and openToWork are filters,
  // not document content, so this changes the record but not the hash.
  const moved = await putProfile({
    about:
      "I manage two hundred beehives and teach urban beekeeping courses: queen rearing, varroa treatment, honey extraction.",
    location: "Antwerp, Belgium",
  })
  await indexedRev(moved.body.commit?.rev ?? "")
  const settledMove = await until(async () => {
    const row = await embeddingRow(did)
    return row && !row.dirty_at && row.updated_at > afterEdit.updated_at && row
  })
  check(
    Boolean(settledMove.value) &&
      settledMove.value!.embed_count === 2 &&
      settledMove.value!.embedded_hash === afterEdit.embedded_hash,
    "a record change outside the document is processed without a model call",
    settledMove.value
      ? `hash unchanged, embed count still ${settledMove.value.embed_count}`
      : took(settledMove)
  )

  const afterMove = (await embeddingRow(did))!
  const same = await putProfile({
    about:
      "I manage two hundred beehives and teach urban beekeeping courses: queen rearing, varroa treatment, honey extraction.",
    location: "Antwerp, Belgium",
  })
  const sameRev = same.body.commit?.rev as string | undefined
  if (sameRev) await indexedRev(sameRev)
  const settledSame = await until(async () => {
    const row = await embeddingRow(did)
    return row && !row.dirty_at && row
  })
  const statsAfter = (await admin("embedder")).body
  check(
    same.ok &&
      settledSame.value?.embed_count === 2 &&
      settledSame.value.embedded_at?.getTime() ===
        afterMove.embedded_at?.getTime(),
    "re-saving identical content does not re-embed",
    `${sameRev ? `PDS wrote commit ${sameRev}` : "PDS made no commit"}; embed count ${settledSame.value?.embed_count}`
  )
  check(
    statsAfter.calls === statsBefore.calls,
    "no embedding API calls during either no-op write",
    `worker calls ${statsBefore.calls} → ${statsAfter.calls}`
  )

  // --- 3. deletion and deactivation remove it ----------------------------------
  section("3. delete and deactivate")

  await xrpc(PDS, "com.atproto.repo.deleteRecord", {
    body: {
      repo: did,
      collection: sh.authentiq.actor.profile.$nsid,
      rkey: "self",
    },
    auth: jwt,
  })
  const deleted = await until(async () => !(await embeddingRow(did)))
  check(
    Boolean(deleted.value),
    "deleting the profile record removes the vector",
    took(deleted)
  )
  check(!(await found(PARAPHRASE, did)), "and it is gone from results")

  await putProfile()
  const back = await until(() => fresh(did))
  check(
    Boolean(back.value),
    "re-creating the profile embeds it again",
    took(back)
  )

  await xrpc(PDS, "com.atproto.server.deactivateAccount", {
    body: {},
    auth: jwt,
  })
  const hidden = await until(async () => !(await embeddingRow(did)))
  check(
    Boolean(hidden.value),
    "deactivating the account removes the vector",
    took(hidden)
  )
  check(!(await found(PARAPHRASE, did)), "and it is gone from results")
  await xrpc(PDS, "com.atproto.server.activateAccount", {
    post: true,
    auth: jwt,
  })
  const reactivated = await until(() => fresh(did))
  check(
    Boolean(reactivated.value),
    "reactivation re-embeds it",
    took(reactivated)
  )
  check(await found(PARAPHRASE, did), "and it is found again")

  // --- 4. filters and fusion ------------------------------------------------------
  section("4. filters and hybrid fusion (talent corpus)")

  const warsaw = await search("engineer", { location: "Warsaw", limit: "20" })
  check(
    (warsaw.results?.length ?? 0) > 0 &&
      warsaw.results!.every((r) => r.actor.location?.includes("Warsaw")),
    "location filter",
    `${warsaw.results?.length} result(s), all in Warsaw`
  )
  const open = await search("engineer", { openToWork: "true", limit: "20" })
  const closed = await search("engineer", { openToWork: "false", limit: "20" })
  check(
    (open.results?.length ?? 0) > 0 &&
      open.results!.every((r) => r.actor.openToWork === true) &&
      (closed.results?.length ?? 0) > 0 &&
      closed.results!.every((r) => !r.actor.openToWork),
    "openToWork filter, both ways",
    `${open.results?.length} open, ${closed.results?.length} not`
  )
  const skilled = await search("infrastructure", {
    skills: ["Terraform", "Helm"],
    limit: "20",
  })
  const skillOk = await Promise.all(
    (skilled.results ?? []).map(async (r) => {
      const p = await xrpc(APPVIEW, "sh.authentiq.actor.getProfile", {
        params: { actor: r.actor.did },
      })
      const skills = ((p.body.skills ?? []) as Array<string>).map((s) =>
        s.toLowerCase()
      )
      return skills.includes("terraform") && skills.includes("helm")
    })
  )
  check(
    skillOk.length > 0 && skillOk.every(Boolean),
    "skills filter (all must be listed)",
    `${skillOk.length} result(s) with both Terraform and Helm`
  )
  for (const mode of ["vector", "fts"]) {
    const filtered = await search("engineer", {
      mode,
      location: "Warsaw",
      limit: "20",
    })
    check(
      (filtered.results ?? []).every((r) =>
        r.actor.location?.includes("Warsaw")
      ),
      `filters apply inside the ${mode} retriever, not after fusion`,
      `${filtered.results?.length} result(s)`
    )
  }
  // Two unrelated needs in one query: full-text matches the literal
  // "Terraform" in profiles that are semantically far from a nurse, so it
  // finds people the vector retriever's top 50 leaves out, and vice versa.
  const fused = await search("nurse who knows Terraform", { limit: "50" })
  const only = (m: string) =>
    (fused.results ?? []).filter(
      (r) => r.matchedBy.length === 1 && r.matchedBy[0] === m
    ).length
  check(
    only("vector") > 0 && only("fts") > 0,
    "hybrid results include hits only one retriever found",
    `${only("vector")} vector-only, ${only("fts")} fts-only, ${(fused.results ?? []).length - only("vector") - only("fts")} both`
  )
  const neutral = await search("site reliability engineer", { limit: "10" })
  const biased = await search(
    "young female site reliability engineer under 30",
    { limit: "10" }
  )
  const order = (r: typeof neutral) =>
    (r.results ?? []).map((x) => x.actor.did).join(",")
  check(
    order(neutral) === order(biased) && order(neutral) !== "",
    "protected-attribute terms have no effect on results",
    `ignored ${JSON.stringify(biased.ignoredTerms)}`
  )

  // --- 5. embedding API outage ----------------------------------------------------
  section("5. embedding API unreachable")

  const cursorBefore = (await admin("indexer")).body.cursor as number
  const down = await admin("embedder/endpoint", { url: DEAD_URL })
  check(
    down.status === 200 && down.body.serverURL === DEAD_URL,
    "embedding client pointed at a dead URL",
    DEAD_URL
  )

  const outageTerm = "mead"
  const during = await putProfile({
    about:
      "I manage two hundred beehives: queen rearing, varroa treatment, honey extraction, and I brew mead from our own honey.",
  })
  const indexedDuring = await until(async () => {
    const [row] = await db`select about from profile where did = ${did}`
    return (row?.about as string | undefined)?.includes(outageTerm)
  })
  check(
    during.ok && Boolean(indexedDuring.value),
    "the firehose event is indexed regardless",
    took(indexedDuring)
  )
  const stuck = await until(async () => {
    const row = await embeddingRow(did)
    return (
      row &&
      row.attempts > 0 &&
      row.dirty_at &&
      row.document.includes(outageTerm) &&
      row
    )
  })
  check(
    Boolean(stuck.value) &&
      stuck.value!.content_hash !== stuck.value!.embedded_hash,
    "the embedding stays queued, with backoff",
    stuck.value
      ? `attempts ${stuck.value.attempts}, last error “${stuck.value.last_error}”`
      : took(stuck)
  )
  const cursorDuring = (await admin("indexer")).body.cursor as number
  check(
    cursorDuring > cursorBefore,
    "the firehose cursor keeps advancing",
    `${cursorBefore} → ${cursorDuring}`
  )
  const degraded = await search(`beekeeper who brews ${outageTerm}`)
  check(
    degraded.degraded === true &&
      (degraded.results ?? []).some((r) => r.actor.did === did),
    "search degrades to full-text and still finds the new text",
    `degraded: ${degraded.degraded}`
  )

  const up = await admin("embedder/endpoint", {})
  const caughtUp = await until(async () => {
    const row = await fresh(did)
    return row?.document.includes(outageTerm) && row
  })
  check(
    up.status === 200 && Boolean(caughtUp.value),
    "embeddings catch up once the API is back",
    took(caughtUp)
  )
  check(
    await found("beekeeper who makes honey wine", did, { mode: "vector" }),
    "and vector search sees the new text"
  )
} catch (err) {
  check(false, "unexpected error", (err as Error).message)
} finally {
  await admin("embedder/endpoint", {})
  section("cleanup")
  const deletedAccount = await xrpc(PDS, "com.atproto.admin.deleteAccount", {
    body: { did },
    auth: PDS_ADMIN,
  })
  const purged = await until(
    async () =>
      (
        await db`select 1 from embedding where did = ${did} union all select 1 from actor where did = ${did}`
      ).length === 0
  )
  check(
    deletedAccount.ok && Boolean(purged.value),
    "account deletion removes the actor and its embedding",
    took(purged)
  )
  await db.close()
}

console.log(
  failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`
)
process.exit(failures === 0 ? 0 : 1)
