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
        const result = handler.validate(entry.rkey, cborToLexRecord(bytes))
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

/**
 * Startup pass: every repo on the PDS that the index has not backfilled yet.
 * On a real network this would list repos from a relay; locally the PDS is
 * the only host.
 */
export async function backfillKnownRepos(runner: MemoryRunner) {
  const done = new Set(
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

  if (pending.length === 0) return
  console.log(`[indexer] backfilling ${pending.length} repo(s)`)

  // A few at a time; each one still runs in its actor's partition.
  const workers = Array.from({ length: 4 }, async () => {
    for (let did = pending.shift(); did; did = pending.shift()) {
      const target = did
      await runner.addTask(target, () => backfillIfNeeded(target))
    }
  })
  await Promise.all(workers)
}

/** Re-checked inside the partition: a firehose event may have got there first. */
async function backfillIfNeeded(did: string) {
  const [row] = await db
    .select({ backfilledAt: schema.actor.backfilledAt })
    .from(schema.actor)
    .where(eq(schema.actor.did, did))
  if (row?.backfilledAt) return
  try {
    await backfillRepo(did)
  } catch (err) {
    console.error(`[indexer] backfill of ${did} failed:`, err)
  }
}
