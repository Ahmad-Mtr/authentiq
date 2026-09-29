import { Firehose, MemoryRunner } from "@atproto/sync"
import type { AccountEvt, CommitEvt, Event } from "@atproto/sync"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { schema } from "@workspace/db"
import { NSID_PREFIX } from "@workspace/atproto"
import { db } from "../db.ts"
import { env } from "../env.ts"
import {
  markDirty,
  markExistingDirty,
  removeActorEmbeddings,
} from "../embed/subjects.ts"
import { backfillKnownRepos, backfillRepo } from "./backfill.ts"
import { logInvalid } from "./collections.ts"
import { idResolver, resolveIdentity, upsertActor } from "./identity.ts"
import { collections } from "./registry.ts"

const CURSOR_KEY = "firehose:cursor"

export type IndexerStatus = {
  running: boolean
  service: string
  /** The saved cursor this run resumed from; null means "live" (no cursor). */
  startedFrom: number | null
  /** Highest seq fully processed so far in this run. */
  cursor: number | null
}

/**
 * The firehose indexer: subscribes to the PDS's `subscribeRepos`, keeps
 * `sh.authentiq.*` writes plus identity and account events, validates each
 * record, and writes the result to Postgres.
 *
 * Events run through a `MemoryRunner`: concurrent across repos, serial within
 * one, and the cursor only advances past a seq once every earlier seq is
 * done. Backfill tasks run in the same per-repo partitions.
 */
export function createIndexer() {
  let firehose: Firehose | undefined
  let runner: MemoryRunner | undefined
  let startedFrom: number | null = null

  const status = (): IndexerStatus => ({
    running: firehose !== undefined,
    service: env.FIREHOSE_URL,
    startedFrom,
    cursor: runner?.getCursor() ?? null,
  })

  async function start() {
    if (firehose) return status()
    const saved = await loadCursor()
    startedFrom = saved ?? null
    const r = new MemoryRunner({ startCursor: saved, setCursor: saveCursor })
    runner = r
    firehose = new Firehose({
      idResolver,
      runner: r,
      service: env.FIREHOSE_URL,
      filterCollections: [`${NSID_PREFIX}*`],
      // `*.test` handles have no DNS; identity events are verified in
      // `resolveIdentity` against the PDS instead.
      unauthenticatedHandles: true,
      handleEvent,
      onError: (err) =>
        console.error(`[indexer] ${err.message}:`, err.cause ?? ""),
    })
    void firehose.start()
    console.log(
      `[indexer] subscribed to ${env.FIREHOSE_URL} from ${saved === undefined ? "live" : `cursor ${saved}`}`
    )
    void backfillKnownRepos(r).catch((err) =>
      console.error("[indexer] startup backfill failed:", err)
    )
    return status()
  }

  /** Stops consuming. In-flight events finish; queued ones replay next start. */
  async function stop() {
    if (!firehose || !runner) return status()
    await firehose.destroy()
    await runner.destroy()
    firehose = undefined
    runner = undefined
    console.log("[indexer] stopped")
    return status()
  }

  /** Re-reads one repo whole, in its partition if the indexer is running. */
  async function backfill(did: string) {
    if (runner) await runner.addTask(did, () => backfillRepo(did))
    else await backfillRepo(did)
  }

  return { start, stop, status, backfill }
}

export type Indexer = ReturnType<typeof createIndexer>

async function handleEvent(evt: Event) {
  switch (evt.event) {
    case "create":
    case "update":
    case "delete":
      return indexCommit(evt)
    case "identity":
      return onIdentity(evt.did)
    case "account":
      return onAccount(evt)
    case "sync":
      // The repo was reset or its history can't be followed; read it whole.
      return backfillRepo(evt.did)
  }
}

async function indexCommit(evt: CommitEvt) {
  const handler = collections.get(evt.collection)
  if (!handler) return

  const [actor] = await db
    .select({ rev: schema.actor.rev, backfilledAt: schema.actor.backfilledAt })
    .from(schema.actor)
    .where(eq(schema.actor.did, evt.did))
  // First sight of this repo: read it whole. The snapshot includes this commit.
  if (!actor?.backfilledAt) return backfillRepo(evt.did)
  // Already reflected, e.g. replayed after a restart, or older than the
  // backfill snapshot. Revs are TIDs, so they sort as strings.
  if (actor.rev && evt.rev < actor.rev) return

  const uri = evt.uri.toString()
  await db.transaction(async (tx) => {
    if (evt.event === "delete") {
      await handler.delete(tx, uri)
    } else {
      const result = handler.validate(evt.rkey, evt.record)
      if (result.ok) {
        const ref = { uri, cid: evt.cid.toString(), did: evt.did }
        await handler.upsert(tx, ref, result.value)
      } else {
        logInvalid(uri, result.reason)
        // An update can turn an indexed record invalid; the old version goes.
        await handler.delete(tx, uri)
      }
    }
    // Same transaction as the write: the embedding worker picks it up later,
    // so a model outage never holds up or loses a firehose event.
    const target = handler.embeds?.({ uri, did: evt.did })
    if (target) await markDirty(tx, target.kind, target.subject, evt.did)
    await tx
      .update(schema.actor)
      .set({ rev: evt.rev })
      .where(
        and(
          eq(schema.actor.did, evt.did),
          or(isNull(schema.actor.rev), lt(schema.actor.rev, evt.rev))
        )
      )
  })
}

/** Handle changes (and key rotations) arrive as `#identity`. */
async function onIdentity(did: string) {
  // Refresh the cached DID document the firehose verifies commits with.
  await idResolver.did.resolve(did, true)
  const { handle } = await resolveIdentity(did)
  await db.transaction((tx) => upsertActor(tx, did, { handle }))
  console.log(`[indexer] identity ${did} → ${handle ?? "handle.invalid"}`)
}

/** Deactivation, suspension and takedown hide the actor; deletion drops it. */
async function onAccount(evt: AccountEvt) {
  console.log(
    `[indexer] account ${evt.did} ${evt.active ? "active" : evt.status}`
  )
  if (evt.status === "deleted") {
    await db.delete(schema.actor).where(eq(schema.actor.did, evt.did))
    return
  }
  await db.transaction(async (tx) => {
    await upsertActor(tx, evt.did, {
      active: evt.active,
      status: evt.active ? null : (evt.status ?? null),
    })
    // Hidden actors leave search at once; reactivated ones are re-embedded.
    if (evt.active) {
      await markDirty(tx, "actor", evt.did, evt.did)
      await markExistingDirty(tx, evt.did)
    } else {
      await removeActorEmbeddings(tx, evt.did)
    }
  })
  if (!evt.active) return
  const [actor] = await db
    .select({ backfilledAt: schema.actor.backfilledAt })
    .from(schema.actor)
    .where(eq(schema.actor.did, evt.did))
  if (!actor?.backfilledAt) await backfillRepo(evt.did)
}

async function loadCursor(): Promise<number | undefined> {
  const [row] = await db
    .select({ value: schema.serviceState.value })
    .from(schema.serviceState)
    .where(eq(schema.serviceState.key, CURSOR_KEY))
  return typeof row?.value === "number" ? row.value : undefined
}

/**
 * Called after every processed event. Partitions finish concurrently, so
 * writes can land out of order; the cursor only ever moves forward.
 */
async function saveCursor(seq: number) {
  await db
    .insert(schema.serviceState)
    .values({ key: CURSOR_KEY, value: seq })
    .onConflictDoUpdate({
      target: schema.serviceState.key,
      set: { value: seq, updatedAt: new Date() },
      setWhere: sql`(${schema.serviceState.value})::bigint < ${seq}`,
    })
}
