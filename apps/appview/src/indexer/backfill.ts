import { cborToLexRecord, verifyRepoCar } from "@atproto/repo"
import type { MemoryRunner } from "@atproto/sync"
import { eq, isNotNull } from "drizzle-orm"
import { schema } from "@workspace/db"
import { AtUri } from "@workspace/atproto"
import { db } from "../db.ts"
import { env } from "../env.ts"
import {
  markDirty,
  markExistingDirty,
  removeActorEmbeddings,
} from "../embed/subjects.ts"
import { logInvalid } from "./collections.ts"
import { idResolver, resolveIdentity, upsertActor } from "./identity.ts"
import { collections } from "./registry.ts"

/** getRepo errors for repos that exist but cannot be read, by account status. */
const UNAVAILABLE: Record<string, string> = {
  RepoNotFound: "deleted",
  RepoTakendown: "takendown",
  RepoSuspended: "suspended",
  RepoDeactivated: "deactivated",
}

/**
 * Reads a whole repo with `com.atproto.sync.getRepo`, verifies it against the
 * actor's signing key, and makes the index match it: valid records are
 * upserted, anything else of theirs is removed. Idempotent, so it is safe to
 * run on a repo that is already indexed.
 *
 * Callers must run it in the actor's runner partition, so it cannot interleave
 * with that actor's firehose events.
 */
export async function backfillRepo(did: string) {
  const { handle, pds } = await resolveIdentity(did)
  const url = new URL("/xrpc/com.atproto.sync.getRepo", pds)
  url.searchParams.set("did", did)
  const res = await fetch(url)

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    const status = body.error ? UNAVAILABLE[body.error] : undefined
    if (status === "deleted") {
      await db.delete(schema.actor).where(eq(schema.actor.did, did))
      return
    }
    if (status) {
      await db.transaction(async (tx) => {
        await upsertActor(tx, did, { handle, active: false, status })
        await removeActorEmbeddings(tx, did)
      })
      return
    }
    throw new Error(`getRepo ${did}: ${res.status} ${body.error ?? ""}`)
  }

  const car = new Uint8Array(await res.arrayBuffer())
  // Force a key refresh: a backfill is rare, and a rotated key must not fail it.
  const signingKey = await idResolver.did.resolveAtprotoKey(did, true)
  const repo = await verifyRepoCar(car, did, signingKey)

  let indexed = 0
  let invalid = 0
  await db.transaction(async (tx) => {
    await upsertActor(tx, did, {
      handle,
      active: true,
      status: null,
      rev: repo.commit.rev,
      backfilledAt: new Date(),
    })
    for (const handler of collections.values()) {
      const keep: Array<string> = []
      for (const entry of repo.creates) {
        if (entry.collection !== handler.collection) continue
        const bytes = repo.commit.newBlocks.get(entry.cid)
        if (!bytes) continue
        const uri = AtUri.make(did, entry.collection, entry.rkey).toString()
        const result = handler.validate(
          { uri, did, rkey: entry.rkey },
          cborToLexRecord(bytes)
        )
        if (!result.ok) {
          logInvalid(uri, result.reason)
          invalid++
          continue
        }
        await handler.upsert(
          tx,
          { uri, cid: entry.cid.toString(), did },
          result.value
        )
        keep.push(uri)
        indexed++
      }
      await handler.prune(tx, did, keep)
      // Every subject the snapshot feeds is rebuilt; so are subjects whose
      // records were pruned, which then drop out.
      for (const target of new Map(
        keep.flatMap((uri) => {
          const t = handler.embeds?.({ uri, did })
          return t ? [[t.subject, t] as const] : []
        })
      ).values()) {
        await markDirty(tx, target.kind, target.subject, did)
      }
    }
    await markExistingDirty(tx, did)
  })
  console.log(
    `[indexer] backfilled ${handle ?? did} at rev ${repo.commit.rev}: ${indexed} records, ${invalid} invalid`
  )
}

/** The registered collections the last complete startup pass indexed. */
const COLLECTIONS_KEY = "indexer:collections"

/**
 * Startup pass: every repo on the PDS that the index has not backfilled yet.
 * When the set of registered collections has changed since the last pass (a
 * phase added lexicons), every repo is read again instead: repos backfilled
 * before a handler existed hold records it has never seen, and the firehose
 * will not replay them. On a real network this would list repos from a
 * relay; locally the PDS is the only host.
 */
export async function backfillKnownRepos(runner: MemoryRunner) {
  const registered = [...collections.keys()].sort()
  const [saved] = await db
    .select({ value: schema.serviceState.value })
    .from(schema.serviceState)
    .where(eq(schema.serviceState.key, COLLECTIONS_KEY))
  const rereadAll =
    JSON.stringify(saved?.value ?? null) !== JSON.stringify(registered)

  const done = rereadAll
    ? new Set<string>()
    : new Set(
        (
          await db
            .select({ did: schema.actor.did })
            .from(schema.actor)
            .where(isNotNull(schema.actor.backfilledAt))
        ).map((r) => r.did)
      )

  const pending: Array<string> = []
  let cursor: string | undefined
  do {
    const url = new URL("/xrpc/com.atproto.sync.listRepos", env.PDS_URL)
    url.searchParams.set("limit", "1000")
    if (cursor) url.searchParams.set("cursor", cursor)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`listRepos: ${res.status}`)
    const page = (await res.json()) as {
      cursor?: string
      repos: Array<{ did: string; active?: boolean }>
    }
    for (const repo of page.repos) {
      if (!done.has(repo.did) && repo.active !== false) pending.push(repo.did)
    }
    cursor = page.repos.length ? page.cursor : undefined
  } while (cursor)

  if (pending.length > 0) {
    console.log(
      `[indexer] backfilling ${pending.length} repo(s)` +
        (rereadAll ? " (registered collections changed)" : "")
    )
    let failed = 0
    // A few at a time; each one still runs in its actor's partition.
    const workers = Array.from({ length: 4 }, async () => {
      for (let did = pending.shift(); did; did = pending.shift()) {
        const target = did
        await runner.addTask(target, async () => {
          if (!(await backfillIfNeeded(target, rereadAll))) failed++
        })
      }
    })
    await Promise.all(workers)
    // A repo that failed is retried by the next start.
    if (failed > 0) return
  }
  if (rereadAll) {
    await db
      .insert(schema.serviceState)
      .values({ key: COLLECTIONS_KEY, value: registered })
      .onConflictDoUpdate({
        target: schema.serviceState.key,
        set: { value: registered, updatedAt: new Date() },
      })
  }
}

/**
 * Re-checked inside the partition: a firehose event may have got there
 * first. Returns false if the backfill failed.
 */
async function backfillIfNeeded(did: string, force: boolean) {
  if (!force) {
    const [row] = await db
      .select({ backfilledAt: schema.actor.backfilledAt })
      .from(schema.actor)
      .where(eq(schema.actor.did, did))
    if (row?.backfilledAt) return true
  }
  try {
    await backfillRepo(did)
    return true
  } catch (err) {
    console.error(`[indexer] backfill of ${did} failed:`, err)
    return false
  }
}
