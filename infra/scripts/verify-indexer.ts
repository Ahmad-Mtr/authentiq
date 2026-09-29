/**
 * End-to-end check of the phase 3 indexer, against the live stack:
 *
 *   PDS write → firehose → validation → Postgres → sh.authentiq.actor.getProfile
 *
 * Works on a throwaway account (`idx-….test`) that it deletes at the end.
 * Needs the AppView running (`bun run dev`) with ADMIN_TOKEN set in
 * apps/appview/.env: the restart and backfill checks stop and start the
 * indexer through /_admin.
 *
 *   bun run verify:indexer
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
const ADMIN_TOKEN = appviewEnv.ADMIN_TOKEN ?? ""
const PDS_ADMIN = `Basic ${btoa(`admin:${infraEnv.PDS_ADMIN_PASSWORD}`)}`
const TIMEOUT_MS = 10_000

const db = new SQL(
  `postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`
)

let failures = 0
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
}
const section = (title: string) => console.log(`\n${title}`)

/**
 * Polls until `probe` returns something truthy, or times out. Returns the
 * value and how long it took, so every check reports its indexing latency.
 */
async function until<T>(probe: () => Promise<T | undefined | null | false>) {
  const started = performance.now()
  while (performance.now() - started < TIMEOUT_MS) {
    const value = await probe()
    if (value) return { value, ms: Math.round(performance.now() - started) }
    await Bun.sleep(50)
  }
  return { value: undefined, ms: TIMEOUT_MS }
}
const took = (r: { value: unknown; ms: number }) =>
  r.value ? `${r.ms} ms` : `timed out after ${TIMEOUT_MS} ms`

async function call(
  base: string,
  method: string,
  opts: {
    body?: unknown
    params?: Record<string, string>
    auth?: string
    /** POST with no body; some procedures reject an empty `{}`. */
    post?: boolean
  } = {}
) {
  const url = new URL(`/xrpc/${method}`, base)
  for (const [k, v] of Object.entries(opts.params ?? {}))
    url.searchParams.set(k, v)
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

async function admin(path: string, body?: unknown) {
  const res = await fetch(new URL(`/_admin/${path}`, APPVIEW), {
    method: body === undefined && !path.includes("/") ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, any>,
  }
}

const getProfile = (actor: string) =>
  call(APPVIEW, "sh.authentiq.actor.getProfile", { params: { actor } })

const indexedPosition = async (uri: string) =>
  (await db`select uri, title, start_date from position where uri = ${uri}`)[0]
const indexedProfile = async (did: string) =>
  (await db`select display_name, headline from profile where did = ${did}`)[0]
const savedCursor = async () =>
  (await db`select value from service_state where key = 'firehose:cursor'`)[0]
    ?.value as number | undefined

// --- 0. preconditions --------------------------------------------------------

const health = await fetch(new URL("/xrpc/_health", APPVIEW)).catch(() => null)
if (!health?.ok) {
  console.log(
    `✗ AppView not reachable at ${APPVIEW} (start it with \`bun run dev\`)`
  )
  process.exit(1)
}
const initial = await admin("indexer")
if (initial.status !== 200) {
  console.log(
    `✗ /_admin/indexer returned ${initial.status} — is ADMIN_TOKEN set in apps/appview/.env, and the AppView restarted since?`
  )
  process.exit(1)
}
check(initial.body.running === true, "indexer is running", initial.body.service)

const suffix = Date.now().toString(36)
const handle = `idx-${suffix}.test`
const account = await call(PDS, "com.atproto.server.createAccount", {
  body: { handle, email: `idx-${suffix}@authentiq.test`, password: "password" },
})
const did = account.body.did as string
const jwt = `Bearer ${account.body.accessJwt}`
check(account.ok, "throwaway account created on the PDS", `${handle} ${did}`)
if (!account.ok) process.exit(1)

const repoWrite = (method: string, body: Record<string, unknown>) =>
  call(PDS, `com.atproto.repo.${method}`, {
    body: { repo: did, ...body },
    auth: jwt,
  })

const now = () => new Date().toISOString()
const profileRecord = (headline: string) => ({
  $type: sh.authentiq.actor.profile.$nsid,
  displayName: "Indexer Probe",
  headline,
  skills: ["Firehoses"],
  createdAt: now(),
})
const positionRecord = (title: string, dates: Record<string, string>) => ({
  $type: sh.authentiq.actor.position.$nsid,
  title,
  organization: "Authentiq",
  createdAt: now(),
  ...dates,
})
const putProfile = (headline: string) =>
  repoWrite("putRecord", {
    collection: sh.authentiq.actor.profile.$nsid,
    rkey: "self",
    record: profileRecord(headline),
  })
const createPosition = (title: string, dates: Record<string, string>) =>
  repoWrite("createRecord", {
    collection: sh.authentiq.actor.position.$nsid,
    record: positionRecord(title, dates),
  })
const rkeyOf = (uri: string) => uri.split("/").at(-1)!

try {
  // --- 1. a profile write reaches the index and getProfile -------------------
  section("1. write → index → getProfile")

  await putProfile("v1")
  const profileIndexed = await until(async () => {
    const row = await indexedProfile(did)
    return row?.headline === "v1" && row
  })
  check(
    Boolean(profileIndexed.value),
    "profile indexed in Postgres",
    took(profileIndexed)
  )
  const served = await until(async () => {
    const res = await getProfile(handle)
    return res.body.headline === "v1" && res.body
  })
  check(
    served.value?.displayName === "Indexer Probe" &&
      served.value?.handle === handle,
    "getProfile serves it from the index",
    served.value
      ? `${served.value.handle} “${served.value.displayName}”`
      : took(served)
  )

  // --- 2. updates and deletes ------------------------------------------------
  section("2. update and delete")

  await putProfile("v2")
  const updated = await until(
    async () => (await indexedProfile(did))?.headline === "v2"
  )
  check(
    Boolean(updated.value),
    "profile update replaces the indexed row",
    took(updated)
  )
  check(
    (await getProfile(handle)).body.headline === "v2",
    "getProfile returns the updated headline"
  )

  const created = await createPosition("Temporary role", {
    startDate: "2025-01",
  })
  const posUri = created.body.uri as string
  const posIndexed = await until(() => indexedPosition(posUri))
  check(
    Boolean(posIndexed.value),
    "position create is indexed",
    took(posIndexed)
  )
  check(
    (await getProfile(handle)).body.positions?.some(
      (p: any) => p.uri === posUri
    ),
    "getProfile lists the position"
  )
  await repoWrite("deleteRecord", {
    collection: sh.authentiq.actor.position.$nsid,
    rkey: rkeyOf(posUri),
  })
  const posGone = await until(async () => !(await indexedPosition(posUri)))
  check(
    Boolean(posGone.value),
    "position delete removes it from the index",
    took(posGone)
  )
  check(
    !(await getProfile(handle)).body.positions?.some(
      (p: any) => p.uri === posUri
    ),
    "getProfile no longer lists it"
  )

  // --- 3. invalid records are stored by the PDS, never indexed ----------------
  section("3. invalid records")

  // "last spring" already breaks the lexicon's maxLength of 7; "2024/06" fits
  // the lexicon and is caught only by the YYYY / YYYY-MM business rule.
  const invalid = {
    "startDate “last spring”": await createPosition("Vague role", {
      startDate: "last spring",
    }),
    "startDate “2024/06”": await createPosition("Slashed role", {
      startDate: "2024/06",
    }),
    "endDate before startDate": await createPosition("Time traveller", {
      startDate: "2024-06",
      endDate: "2023-01",
    }),
    "missing required organization": await repoWrite("createRecord", {
      collection: sh.authentiq.actor.position.$nsid,
      record: {
        $type: sh.authentiq.actor.position.$nsid,
        title: "No org",
        startDate: "2024",
        createdAt: now(),
      },
    }),
    "education month 13": await repoWrite("createRecord", {
      collection: sh.authentiq.actor.education.$nsid,
      record: {
        $type: sh.authentiq.actor.education.$nsid,
        school: "Nowhere U",
        startDate: "2019-13",
        createdAt: now(),
      },
    }),
    "profile at rkey ≠ self": await repoWrite("putRecord", {
      collection: sh.authentiq.actor.profile.$nsid,
      rkey: "other",
      record: profileRecord("wrong key"),
    }),
  }
  for (const [label, res] of Object.entries(invalid)) {
    check(
      res.ok && res.body.validationStatus === "unknown",
      `PDS accepts ${label}`,
      res.body.validationStatus ?? res.body.error
    )
  }

  // A valid write after the invalid ones. Events for one repo are processed in
  // order, so once it is indexed the invalid ones have been seen — and dropped.
  const sentinel = await createPosition("Sentinel", {
    startDate: "2020",
    endDate: "2020-03",
  })
  const sentinelIndexed = await until(() => indexedPosition(sentinel.body.uri))
  check(
    Boolean(sentinelIndexed.value),
    "a later valid record is indexed",
    took(sentinelIndexed)
  )
  const invalidUris = Object.values(invalid).map((r) => r.body.uri as string)
  const leaked = await db`
    select uri from position where uri in ${db(invalidUris)}
    union all select uri from education where uri in ${db(invalidUris)}
    union all select uri from profile where uri in ${db(invalidUris)}`
  check(
    leaked.length === 0,
    "none of the invalid records reached the index",
    `${leaked.length} leaked`
  )

  // An update can turn a valid record invalid; the old version must go.
  await repoWrite("putRecord", {
    collection: sh.authentiq.actor.position.$nsid,
    rkey: rkeyOf(sentinel.body.uri),
    record: positionRecord("Sentinel", { startDate: "sometime" }),
  })
  const brokenGone = await until(
    async () => !(await indexedPosition(sentinel.body.uri))
  )
  check(
    Boolean(brokenGone.value),
    "an update that breaks a record removes it",
    took(brokenGone)
  )

  // --- 4. restart resumes from the saved cursor --------------------------------
  section("4. restart from the saved cursor")

  const stopped = await admin("indexer/stop")
  check(stopped.body.running === false, "indexer stopped")
  const cursorAtStop = await savedCursor()
  check(
    typeof cursorAtStop === "number",
    "cursor persisted in service_state",
    String(cursorAtStop)
  )

  await putProfile("written while down")
  const downPos = await createPosition("Written while down", {
    startDate: "2026-01",
  })
  check(
    (await indexedProfile(did))?.headline === "v2" &&
      !(await indexedPosition(downPos.body.uri)),
    "writes made while stopped are not indexed yet"
  )

  const restarted = await admin("indexer/start")
  check(
    restarted.body.running === true &&
      restarted.body.startedFrom === cursorAtStop,
    "indexer resumes from the saved cursor",
    `startedFrom ${restarted.body.startedFrom}`
  )
  const caughtUp = await until(
    async () =>
      (await indexedProfile(did))?.headline === "written while down" &&
      (await indexedPosition(downPos.body.uri))
  )
  check(
    Boolean(caughtUp.value),
    "events written while down are indexed after restart",
    took(caughtUp)
  )
  const cursorAfter = await until(async () => {
    const c = await savedCursor()
    return (
      c !== undefined && cursorAtStop !== undefined && c > cursorAtStop && c
    )
  })
  check(
    Boolean(cursorAfter.value),
    "saved cursor advances past them",
    `${cursorAtStop} → ${cursorAfter.value}`
  )

  // --- 5. backfill -------------------------------------------------------------
  section("5. backfill")

  // Make the index forget the account entirely, then restart. The cursor is
  // already past every event this account produced, so the firehose will not
  // replay them: only the startup backfill (listRepos → getRepo) can bring
  // the records back.
  await admin("indexer/stop")
  await db`delete from actor where did = ${did}`
  const forgotten = await getProfile(handle)
  check(
    forgotten.body.error === "ActorNotFound",
    "index no longer knows the account"
  )
  await admin("indexer/start")

  const backfilled = await until(async () => {
    const [row] = await db`select backfilled_at from actor where did = ${did}`
    return row?.backfilled_at && (await indexedProfile(did)) && row
  })
  check(
    Boolean(backfilled.value),
    "startup backfill re-indexes it from getRepo",
    took(backfilled)
  )
  const after = await getProfile(handle)
  check(
    after.body.headline === "written while down" &&
      after.body.positions?.length === 1 &&
      after.body.positions[0].uri === downPos.body.uri,
    "backfilled profile matches the repo",
    `${after.body.positions?.length} position(s), headline “${after.body.headline}”`
  )
  const leakedAfterBackfill = await db`
    select uri from position where uri in ${db(invalidUris)}
    union all select uri from education where uri in ${db(invalidUris)}`
  check(
    leakedAfterBackfill.length === 0,
    "backfill applies the same validation"
  )

  const snapshot = async () =>
    (
      await db`
        select uri, cid from profile where did = ${did}
        union all select uri, cid from position where did = ${did}
        union all select uri, cid from education where did = ${did}
        order by uri`
    )
      .map((r: { uri: string; cid: string }) => `${r.uri}@${r.cid}`)
      .join("\n")
  const before = await snapshot()
  const again1 = await admin("backfill", { did })
  const again2 = await admin("backfill", { did })
  check(
    again1.status === 200 &&
      again2.status === 200 &&
      (await snapshot()) === before,
    "backfilling again is idempotent",
    `${before.split("\n").length} rows unchanged after 2 more runs`
  )

  // --- 6. identity and account events -----------------------------------------
  section("6. #identity and #account")

  // The PDS caps a handle's first label at 18 characters.
  const newHandle = `idr-${suffix}.test`
  const renamed = await call(PDS, "com.atproto.identity.updateHandle", {
    body: { handle: newHandle },
    auth: jwt,
  })
  const rekeyed = await until(
    async () => (await getProfile(newHandle)).body.did === did
  )
  check(
    renamed.ok && Boolean(rekeyed.value),
    "handle change re-keys the actor",
    renamed.ok ? `${newHandle}, ${took(rekeyed)}` : renamed.body.message
  )
  check(
    (await getProfile(handle)).body.error === "ActorNotFound",
    "old handle no longer resolves"
  )

  await call(PDS, "com.atproto.server.deactivateAccount", {
    body: {},
    auth: jwt,
  })
  const hidden = await until(
    async () => (await getProfile(did)).body.error === "ActorNotFound"
  )
  check(Boolean(hidden.value), "deactivation hides the actor", took(hidden))
  const activated = await call(PDS, "com.atproto.server.activateAccount", {
    post: true,
    auth: jwt,
  })
  const shown = await until(async () => (await getProfile(did)).ok)
  check(
    activated.ok && Boolean(shown.value),
    "reactivation shows it again",
    activated.ok ? took(shown) : activated.body.message
  )

  const takedown = (applied: boolean) =>
    call(PDS, "com.atproto.admin.updateSubjectStatus", {
      body: {
        subject: { $type: "com.atproto.admin.defs#repoRef", did },
        takedown: { applied, ref: "verify-indexer" },
      },
      auth: PDS_ADMIN,
    })
  await takedown(true)
  const takenDown = await until(
    async () => (await getProfile(did)).body.error === "ActorNotFound"
  )
  check(Boolean(takenDown.value), "takedown hides the actor", took(takenDown))
  await takedown(false)
  const restored = await until(async () => (await getProfile(did)).ok)
  check(
    Boolean(restored.value),
    "reversing the takedown restores it",
    took(restored)
  )

  // --- 7. unknown actors -------------------------------------------------------
  section("7. unknown actors")

  const unknownHandle = await getProfile(`nobody-${suffix}.test`)
  check(
    unknownHandle.status === 400 &&
      unknownHandle.body.error === "ActorNotFound",
    "unknown handle → ActorNotFound",
    String(unknownHandle.status)
  )
  const unknownDid = await getProfile("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa")
  check(
    unknownDid.status === 400 && unknownDid.body.error === "ActorNotFound",
    "unknown DID → ActorNotFound",
    String(unknownDid.status)
  )
} finally {
  // --- cleanup: deleting the account is itself an #account event ---------------
  section("cleanup")
  const deleted = await call(PDS, "com.atproto.admin.deleteAccount", {
    body: { did },
    auth: PDS_ADMIN,
  })
  const purged = await until(
    async () => (await db`select 1 from actor where did = ${did}`).length === 0
  )
  check(
    deleted.ok && Boolean(purged.value),
    "account deletion removes the actor and its records",
    took(purged)
  )
  await db.close()
}

console.log(
  failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`
)
process.exit(failures === 0 ? 0 : 1)
