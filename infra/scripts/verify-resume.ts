/**
 * End-to-end check of phase 4 resume parsing, against the live stack:
 *
 *   browser → web BFF → (service auth) → AppView: sniff → extract → Mistral → draft
 *   review → confirm → applyWrites to the PDS → firehose → getProfile
 *
 * Works on a throwaway account (`rsm-….test`) that it deletes at the end.
 * Uploads go through the web app's /api/resume/* routes with a real OAuth
 * session, so the service-auth path is the one the browser uses. It calls the
 * real parser three times (fractions of a cent).
 *
 *   bun run verify:resume
 */
import { createHash } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Secp256k1Keypair } from "@atproto/crypto"
import { SQL } from "bun"
import { LOCAL_NETWORK } from "@workspace/atproto"
import { sh } from "@workspace/lexicons"
import { prf, score, sum } from "./lib/resume-score.ts"
import type { Draft } from "./lib/resume-score.ts"
import { signInToWeb } from "./lib/web-session.ts"

const root = join(import.meta.dir, "..", "..")
const readEnv = async (path: string) =>
  Object.fromEntries(
    (await Bun.file(join(root, path)).text())
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  )
const infraEnv = await readEnv("infra/.env")

const WEB = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000"
const PDS = process.env.PDS_URL ?? LOCAL_NETWORK.pdsUrl
const APPVIEW = process.env.APPVIEW_URL ?? LOCAL_NETWORK.appviewUrl
const APPVIEW_DID = process.env.APPVIEW_DID ?? "did:web:localhost%3A2584"
const PDS_ADMIN = `Basic ${btoa(`admin:${infraEnv.PDS_ADMIN_PASSWORD}`)}`
const FIXTURES = join(root, "infra", "fixtures", "resumes")
const TIMEOUT_MS = 10_000
/**
 * In 01-classic.pdf's text, and in no field a correct parse would fill. Never
 * printed, so this script's own output cannot trip the disk scan.
 */
const SENTINEL = "QUOKKA-7741"
const RESUME = sh.authentiq.resume
const started = Date.now()

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
  const t0 = performance.now()
  while (performance.now() - t0 < timeout) {
    const value = await probe()
    if (value) return { value, ms: Math.round(performance.now() - t0) }
    await Bun.sleep(100)
  }
  return { value: undefined, ms: timeout }
}
const took = (r: { value: unknown; ms: number }, timeout = TIMEOUT_MS) =>
  r.value ? `${r.ms} ms` : `timed out after ${timeout} ms`

async function xrpc(
  base: string,
  method: string,
  opts: { body?: unknown; params?: Record<string, string>; auth?: string } = {}
) {
  const url = new URL(`/xrpc/${method}`, base)
  for (const [k, v] of Object.entries(opts.params ?? {}))
    url.searchParams.set(k, v)
  const res = await fetch(url, {
    method: opts.body === undefined ? "GET" : "POST",
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

const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(join(FIXTURES, name)).arrayBuffer())
const expectedFor = async (name: string) =>
  (await Bun.file(
    join(FIXTURES, name.replace(/\.(pdf|docx)$/, ".expected.json"))
  ).json()) as Draft
const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

// --- 0. preconditions --------------------------------------------------------

for (const [name, url] of [
  ["AppView", `${APPVIEW}/xrpc/_health`],
  ["web app", WEB],
]) {
  const res = await fetch(url!).catch(() => null)
  if (!res?.ok) {
    console.log(
      `✗ ${name} not reachable at ${url} (start it with \`bun run dev\`)`
    )
    process.exit(1)
  }
}

const suffix = Date.now().toString(36)
const handle = `rsm-${suffix}.test`
const password = "password"
const account = await xrpc(PDS, "com.atproto.server.createAccount", {
  body: { handle, email: `rsm-${suffix}@authentiq.test`, password },
})
const did = account.body.did as string
const jwt = `Bearer ${account.body.accessJwt}`
check(account.ok, "throwaway account created on the PDS", `${handle} ${did}`)
if (!account.ok) process.exit(1)

/** A real service auth token from the user's PDS, as the BFF would get. */
const serviceToken = async (lxm: string) => {
  const res = await xrpc(PDS, "com.atproto.server.getServiceAuth", {
    params: { aud: APPVIEW_DID, lxm },
    auth: jwt,
  })
  return `Bearer ${res.body.token}`
}

const repoState = async () => {
  const [commit, repo, blobs] = await Promise.all([
    xrpc(PDS, "com.atproto.sync.getLatestCommit", { params: { did } }),
    xrpc(PDS, "com.atproto.repo.describeRepo", { params: { repo: did } }),
    xrpc(PDS, "com.atproto.sync.listBlobs", { params: { did } }),
  ])
  return {
    rev: commit.body.rev as string,
    collections: ((repo.body.collections ?? []) as Array<string>).filter((c) =>
      c.startsWith("sh.authentiq.")
    ),
    blobs: ((blobs.body.cids ?? []) as Array<string>).length,
  }
}
const listRecords = async (collection: string) =>
  ((
    await xrpc(PDS, "com.atproto.repo.listRecords", {
      params: { repo: did, collection, limit: "100" },
    })
  ).body.records ?? []) as Array<{ uri: string; value: Record<string, any> }>

const draftRows = async () =>
  (await db`select id, expires_at from resume_draft where did = ${did}`) as Array<{
    id: string
    expires_at: Date
  }>

/** Every row of every table in the AppView database, as text, searched. */
async function databaseContains(needle: string) {
  const tables = (await db`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'`) as Array<{
    table_name: string
  }>
  const hits: Array<string> = []
  for (const { table_name } of tables) {
    const [row] = await db.unsafe(
      `select count(*)::int as n from "${table_name}" t where t::text ilike $1`,
      [`%${needle}%`]
    )
    if (row.n > 0) hits.push(`${table_name} (${row.n})`)
  }
  return hits
}

/**
 * Files written since this run started, under the temp dir and the repo
 * (minus node_modules, .git and the fixtures themselves), that hold the
 * uploaded bytes or the sentinel text.
 */
async function diskCopies(uploadHash: string) {
  const hits: Array<string> = []
  const walk = async (dir: string, depth: number) => {
    if (depth > 6) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        if ([".git", "node_modules", ".turbo", ".tanstack"].includes(e.name))
          continue
        if (path === FIXTURES) continue
        await walk(path, depth + 1)
      } else if (e.isFile()) {
        const s = await stat(path).catch(() => null)
        if (!s || s.mtimeMs < started || s.size > 20 * 1024 * 1024) continue
        const bytes = new Uint8Array(
          await Bun.file(path)
            .arrayBuffer()
            .catch(() => new ArrayBuffer(0))
        )
        if (
          createHash("sha256").update(bytes).digest("hex") === uploadHash ||
          Buffer.from(bytes).includes(SENTINEL)
        ) {
          hits.push(path)
        }
      }
    }
  }
  await walk(tmpdir(), 0)
  await walk(root, 0)
  return hits
}

/** Every string in a draft, for the injection check. */
const strings = (v: unknown): Array<string> =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(strings)
      : v && typeof v === "object"
        ? Object.values(v).flatMap(strings)
        : []

try {
  // --- 1. unauthenticated uploads are rejected -------------------------------
  section("1. unauthenticated uploads are rejected")

  const pdf = await fixture("01-classic.pdf")
  const anon = await fetch(`${WEB}/api/resume/upload`, {
    method: "POST",
    headers: { "content-type": MIME.pdf },
    body: pdf,
  })
  check(
    anon.status === 401,
    "web: upload without a session → 401",
    String(anon.status)
  )

  const direct = await fetch(`${APPVIEW}/xrpc/${RESUME.uploadResume.$lxm}`, {
    method: "POST",
    headers: { "content-type": MIME.pdf },
    body: pdf,
  })
  check(
    direct.status === 401,
    "AppView: upload without a token → 401",
    `${direct.status} ${((await direct.json()) as { error?: string }).error}`
  )

  // A well-formed token for the right audience and method, claiming the
  // user's DID, but signed by a key that is not in their DID document.
  const attacker = await Secp256k1Keypair.create()
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url")
  const unsigned = `${b64({ alg: "ES256K", typ: "JWT" })}.${b64({
    iss: did,
    aud: APPVIEW_DID,
    lxm: RESUME.uploadResume.$lxm,
    exp: Math.floor(Date.now() / 1000) + 60,
    jti: crypto.randomUUID(),
  })}`
  const forgedSig = Buffer.from(
    await attacker.sign(new TextEncoder().encode(unsigned))
  ).toString("base64url")
  const forged = await fetch(`${APPVIEW}/xrpc/${RESUME.uploadResume.$lxm}`, {
    method: "POST",
    headers: {
      "content-type": MIME.pdf,
      authorization: `Bearer ${unsigned}.${forgedSig}`,
    },
    body: pdf,
  })
  check(
    forged.status === 401,
    "AppView: token signed by the wrong key → 401",
    `${forged.status} ${((await forged.json()) as { error?: string }).error}`
  )

  const wrongMethod = await fetch(
    `${APPVIEW}/xrpc/${RESUME.uploadResume.$lxm}`,
    {
      method: "POST",
      headers: {
        "content-type": MIME.pdf,
        authorization: await serviceToken(RESUME.getDraft.$lxm),
      },
      body: pdf,
    }
  )
  check(
    wrongMethod.status === 401,
    "AppView: real token for a different method → 401",
    `${wrongMethod.status} ${((await wrongMethod.json()) as { error?: string }).error}`
  )

  const once = await serviceToken(RESUME.getDraft.$lxm)
  const first = await xrpc(APPVIEW, RESUME.getDraft.$lxm, {
    params: { id: "none" },
    auth: once,
  })
  const replay = await xrpc(APPVIEW, RESUME.getDraft.$lxm, {
    params: { id: "none" },
    auth: once,
  })
  check(
    first.body.error === "DraftNotFound" && replay.status === 401,
    "AppView: a service token works once, a replay → 401",
    `${first.body.error}, then ${replay.status}`
  )

  // --- 2. authenticated upload returns a close draft --------------------------
  section("2. authenticated upload → draft")

  const web = await signInToWeb({ web: WEB, pds: PDS, handle, password })
  check(web.did === did, "signed in to the web app over OAuth", did)

  const before = await repoState()
  const upload = async (name: string, contentType?: string) => {
    const bytes = await fixture(name)
    const res = await web.fetch("/api/resume/upload", {
      method: "POST",
      headers: {
        "content-type":
          contentType ?? MIME[name.endsWith(".pdf") ? "pdf" : "docx"],
      },
      body: bytes,
    })
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, any>,
      hash: createHash("sha256").update(bytes).digest("hex"),
    }
  }
  const t0 = performance.now()
  const a = await upload("01-classic.pdf")
  const draftA = a.body as sh.authentiq.resume.defs.DraftView
  check(
    a.status === 200 && RESUME.defs.draftView.$matches(draftA),
    "upload via the BFF returns a lexicon-valid draft",
    `${a.status} in ${Math.round(performance.now() - t0)} ms`
  )
  if (a.status !== 200)
    throw new Error(`upload failed: ${JSON.stringify(a.body)}`)
  const scoreA = score(
    draftA.draft as Draft,
    await expectedFor("01-classic.pdf")
  )
  const fA = prf(sum(scoreA.counts))
  check(
    fA.f1 >= 0.9 &&
      scoreA.positions.paired === 3 &&
      scoreA.education.paired === 2,
    "draft matches the 01-classic annotation closely",
    `F1 ${(fA.f1 * 100).toFixed(1)}%, positions ${scoreA.positions.paired}/3, education ${scoreA.education.paired}/2` +
      (scoreA.mismatches.length
        ? `; off: ${scoreA.mismatches.map((m) => m.field).join(", ")}`
        : "")
  )
  check(
    draftA.draft.profile.displayName === "Marisol Okonkwo-Lindqvist",
    "displayName extracted",
    draftA.draft.profile.displayName
  )

  // --- 3. nothing reaches the repo before confirmation ------------------------
  section("3. nothing written before confirmation")

  const fetched = await web.fetch(`/profile/import?draft=${draftA.id}`)
  check(fetched.ok, "review page loads the draft", String(fetched.status))
  const afterUpload = await repoState()
  check(
    afterUpload.rev === before.rev,
    "repo revision unchanged",
    afterUpload.rev
  )
  check(
    afterUpload.collections.length === 0,
    "no sh.authentiq.* records in the repo",
    JSON.stringify(afterUpload.collections)
  )
  check(
    afterUpload.blobs === 0,
    "no blobs uploaded to the PDS",
    String(afterUpload.blobs)
  )

  // --- 4. the file and its text are not kept ----------------------------------
  section("4. no stored copy of the file or its text")

  const columns = (
    (await db`select column_name from information_schema.columns
              where table_name = 'resume_draft' order by ordinal_position`) as Array<{
      column_name: string
    }>
  ).map((c) => c.column_name)
  check(
    columns.join(",") === "id,did,draft,created_at,expires_at",
    "resume_draft holds the structured draft only",
    columns.join(", ")
  )
  const [rowA] = await draftRows()
  const ttl = rowA
    ? (new Date(rowA.expires_at).getTime() - Date.now()) / 60000
    : 0
  check(
    Boolean(rowA) && ttl > 25 && ttl <= 30,
    "draft has a 30-minute expiry",
    `${ttl.toFixed(1)} min left`
  )
  const dbHits = await databaseContains(SENTINEL)
  check(
    dbHits.length === 0,
    "resume text is nowhere in Postgres while the draft is under review",
    dbHits.length
      ? `found in ${dbHits.join(", ")}`
      : "sentinel phrase in 0 tables"
  )
  const diskHits = await diskCopies(a.hash)
  check(
    diskHits.length === 0,
    "no copy of the file or its text on disk",
    diskHits.length ? diskHits.join(", ") : "temp dir and repo scanned"
  )

  // --- 5. confirming a subset writes exactly that -----------------------------
  section("5. confirm a subset")

  const confirm = (body: unknown) =>
    web.fetch("/api/resume/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  const p0 = draftA.draft.positions[0]!
  const e0 = draftA.draft.education[0]!

  // The new zod refinement: an end before the start is refused, and a
  // refused confirm writes nothing at all (every record is built first).
  const bad = await confirm({
    draftId: draftA.id,
    profile: { displayName: draftA.draft.profile.displayName },
    positions: [{ ...p0, startDate: "2021-03", endDate: "2020-01" }],
  })
  const badBody = (await bad.json()) as {
    error?: string
    issues?: Array<{ path: string }>
  }
  check(
    bad.status === 400 &&
      badBody.error === "InvalidEntries" &&
      badBody.issues?.some((i) => i.path === "positions.0.endDate") === true,
    "endDate before startDate is refused",
    `${bad.status} ${badBody.issues?.map((i) => i.path).join(", ")}`
  )
  check(
    (await repoState()).rev === before.rev,
    "a refused confirm writes nothing"
  )

  const skills = (draftA.draft.profile.skills ?? []).slice(0, 3)
  const ok = await confirm({
    draftId: draftA.id,
    // Accept name, headline and three skills; reject about and location.
    profile: {
      displayName: draftA.draft.profile.displayName,
      headline: draftA.draft.profile.headline,
      skills,
    },
    // Accept the first position, edited; reject the rest.
    positions: [{ ...p0, title: "Staff Backend Engineer" }],
    education: [e0],
  })
  const okBody = (await ok.json()) as { written?: number; uris?: Array<string> }
  check(
    ok.ok && okBody.written === 3,
    "confirm writes 3 records in one commit",
    `${ok.status} ${okBody.written}`
  )

  const [profiles, positions, education] = await Promise.all([
    listRecords(sh.authentiq.actor.profile.$nsid),
    listRecords(sh.authentiq.actor.position.$nsid),
    listRecords(sh.authentiq.actor.education.$nsid),
  ])
  const prof = profiles[0]?.value
  check(
    profiles.length === 1 &&
      prof?.displayName === draftA.draft.profile.displayName &&
      prof?.headline === draftA.draft.profile.headline &&
      prof?.about === undefined &&
      prof?.location === undefined &&
      JSON.stringify(prof?.skills) === JSON.stringify(skills),
    "profile has exactly the accepted fields",
    `headline “${prof?.headline}”, skills ${JSON.stringify(prof?.skills)}, no about/location`
  )
  check(
    positions.length === 1 &&
      positions[0]!.value.title === "Staff Backend Engineer" &&
      positions[0]!.value.organization === p0.organization,
    "exactly one position, with the user's edit",
    positions
      .map((p) => `${p.value.title} @ ${p.value.organization}`)
      .join("; ")
  )
  check(
    education.length === 1 && education[0]!.value.school === e0.school,
    "exactly one education entry",
    education.map((e) => e.value.school).join("; ")
  )
  const afterConfirm = await repoState()
  check(
    afterConfirm.collections.length === 3 && afterConfirm.blobs === 0,
    "nothing else in the repo, still no blobs",
    `${afterConfirm.collections.join(", ")}; ${afterConfirm.blobs} blobs`
  )
  const indexed = await until(async () => {
    const res = await xrpc(APPVIEW, "sh.authentiq.actor.getProfile", {
      params: { actor: did },
    })
    return (
      res.body.headline === draftA.draft.profile.headline &&
      res.body.positions?.length === 1 &&
      res.body.education?.length === 1 &&
      res.body
    )
  })
  check(
    indexed.value?.positions?.[0]?.title === "Staff Backend Engineer",
    "getProfile serves the confirmed records once indexed",
    took(indexed)
  )
  check((await draftRows()).length === 0, "the draft is deleted on confirm")
  const dbAfterConfirm = await databaseContains(SENTINEL)
  check(
    dbAfterConfirm.length === 0,
    "resume text still nowhere in Postgres",
    dbAfterConfirm.join(", ")
  )
  const gone = await xrpc(APPVIEW, RESUME.getDraft.$lxm, {
    params: { id: draftA.id },
    auth: await serviceToken(RESUME.getDraft.$lxm),
  })
  check(
    gone.body.error === "DraftNotFound",
    "getDraft no longer finds it",
    gone.body.error
  )

  // --- 6. prompt injection -----------------------------------------------------
  section("6. prompt injection")

  const b = await upload("09-prompt-injection.pdf")
  const draftB = b.body as sh.authentiq.resume.defs.DraftView
  check(
    b.status === 200 && RESUME.defs.draftView.$matches(draftB),
    "injection fixture parses to a lexicon-valid draft",
    String(b.status)
  )
  const expectedB = await expectedFor("09-prompt-injection.pdf")
  check(
    draftB.draft.positions.length <= expectedB.positions.length &&
      draftB.draft.education.length <= expectedB.education.length,
    "no extra entries",
    `${draftB.draft.positions.length} position(s), ${draftB.draft.education.length} education`
  )
  const injected = strings(draftB.draft).filter((s) =>
    /globex|chief executive|quantum|visionary|top 1%|hire immediately|pre-approved|ignore all/i.test(
      s
    )
  )
  check(
    injected.length === 0,
    "no injected text in any field",
    injected.join(" | ")
  )
  check(
    draftB.draft.profile.headline === expectedB.profile.headline,
    "headline is the real one",
    draftB.draft.profile.headline
  )
  check(
    (await repoState()).rev === afterConfirm.rev,
    "repo untouched by the upload"
  )

  const cancel = await web.fetch("/api/resume/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: draftB.id }),
  })
  check(
    cancel.ok && ((await cancel.json()) as { deleted: boolean }).deleted,
    "discard deletes the draft"
  )
  check((await draftRows()).length === 0, "no draft row left after discard")
  check((await repoState()).rev === afterConfirm.rev, "discard writes nothing")

  // --- expiry -------------------------------------------------------------------
  section("expiry")

  const c = await upload("05-current-role.pdf")
  const draftC = c.body as sh.authentiq.resume.defs.DraftView
  check(c.status === 200, "another draft to let expire", String(c.status))
  await db`update resume_draft set expires_at = now() - interval '1 second' where id = ${draftC.id}`
  const expired = await web.fetch(`/profile/import?draft=${draftC.id}`)
  check(
    expired.ok && (await expired.text()).includes("has expired"),
    "an expired draft is not served to the review page"
  )
  const lateConfirm = await confirm({
    draftId: draftC.id,
    profile: { headline: "late" },
  })
  check(
    lateConfirm.status === 410,
    "confirming an expired draft → 410, nothing written",
    String(lateConfirm.status)
  )
  const sweepTimeout = 70_000
  const swept = await until(
    async () => (await draftRows()).length === 0,
    sweepTimeout
  )
  check(
    Boolean(swept.value),
    "the sweeper deletes it",
    took(swept, sweepTimeout)
  )

  // --- 7. file type and size ----------------------------------------------------
  section("7. file type and size")

  const reject = async (
    label: string,
    body: Uint8Array,
    contentType: string,
    status: number,
    error: string
  ) => {
    const res = await web.fetch("/api/resume/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    check(
      res.status === status && json.error === error,
      label,
      `${res.status} ${json.error}`
    )
  }
  await reject(
    "a text file named and typed as a PDF → UnsupportedFileType",
    new TextEncoder().encode(
      "Just some plain text, not a PDF at all.\n".repeat(20)
    ),
    MIME.pdf,
    400,
    "UnsupportedFileType"
  )
  // A ZIP with no word/document.xml, e.g. an archive renamed to .docx.
  const zip = Buffer.concat([
    Buffer.from("PK\x03\x04", "latin1"),
    Buffer.alloc(26),
    Buffer.from("notes.txt"),
    Buffer.alloc(200, 0x41),
  ])
  await reject(
    "a ZIP that is not a DOCX → UnsupportedFileType",
    zip,
    MIME.docx,
    400,
    "UnsupportedFileType"
  )
  await reject(
    "a PDF declared as DOCX → UnsupportedFileType",
    await fixture("01-classic.pdf"),
    MIME.docx,
    400,
    "UnsupportedFileType"
  )
  const huge = new Uint8Array(5 * 1024 * 1024 + 1)
  huge.set(new TextEncoder().encode("%PDF-1.7\n"))
  await reject(
    "a 5 MB + 1 byte file → FileTooLarge (web)",
    huge,
    MIME.pdf,
    413,
    "FileTooLarge"
  )
  const hugeDirect = await fetch(
    `${APPVIEW}/xrpc/${RESUME.uploadResume.$lxm}`,
    {
      method: "POST",
      headers: {
        "content-type": MIME.pdf,
        authorization: await serviceToken(RESUME.uploadResume.$lxm),
      },
      body: huge,
    }
  )
  check(
    hugeDirect.status === 413,
    "the same file straight to the AppView → FileTooLarge",
    `${hugeDirect.status} ${((await hugeDirect.json()) as { error?: string }).error}`
  )
  check((await draftRows()).length === 0, "rejected files leave no draft")
  check(
    (await repoState()).rev === afterConfirm.rev,
    "rejected files write nothing"
  )
} catch (err) {
  check(false, "unexpected error", (err as Error).message)
} finally {
  // --- cleanup ---------------------------------------------------------------------
  section("cleanup")
  await db`delete from resume_draft where did = ${did}`
  const deleted = await xrpc(PDS, "com.atproto.admin.deleteAccount", {
    body: { did },
    auth: PDS_ADMIN,
  })
  const purged = await until(
    async () => (await db`select 1 from actor where did = ${did}`).length === 0
  )
  check(
    deleted.ok && Boolean(purged.value),
    "throwaway account deleted",
    took(purged)
  )
  await db.close()
}

console.log(
  failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`
)
process.exit(failures === 0 ? 0 : 1)
