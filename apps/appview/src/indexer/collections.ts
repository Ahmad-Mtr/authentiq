import { and, eq, notInArray } from "drizzle-orm"
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core"
import type { Database } from "@workspace/db"
import { isValidNsid, isValidRecordKey, isValidTid } from "@workspace/atproto"

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

export type RecordRef = { uri: string; cid: string; did: string }

export type Validation =
  { ok: true; value: unknown } | { ok: false; reason: string }

/** Where a record lives, for rules that depend on its author or URI. */
export type RecordLocation = { uri: string; did: string; rkey: string }

/** How the indexer treats one record collection. */
export type CollectionHandler = {
  collection: string
  /**
   * Create-only records (posts): the first valid version indexed is kept,
   * and later updates to it are ignored.
   */
  immutable: boolean
  /** Lexicon validation, then the record-key shape, then business rules. */
  validate: (at: RecordLocation, record: unknown) => Validation
  /** Inserts, or replaces the indexed version unless the collection is immutable. */
  upsert: (tx: Tx, ref: RecordRef, value: unknown) => Promise<void>
  /** Whether a record is indexed. */
  exists: (tx: Tx, uri: string) => Promise<boolean>
  delete: (tx: Tx, uri: string) => Promise<void>
  /** Backfill: drop this actor's rows whose URIs are no longer in the repo. */
  prune: (tx: Tx, did: string, keep: Array<string>) => Promise<void>
  /** The search subject a record feeds, if any (phase 5 embeddings). */
  embeds?: (ref: { uri: string; did: string }) => EmbedTarget
}

export type EmbedTarget = { kind: string; subject: string }

/** The parts of a generated lexicon record module the indexer needs. */
type RecordModule<TValue> = {
  $nsid: string
  main: { key: string }
  // A failed result is itself the LexValidationError.
  $safeParse: (
    input: unknown
  ) => { success: true; value: TValue } | { success: false; message: string }
}

type RecordTable = PgTable & { uri: AnyPgColumn; did: AnyPgColumn }

/**
 * Binds a generated lexicon to its index table. Adding a collection is a
 * table in packages/db plus one of these, registered in `registry.ts`.
 */
export function defineCollection<TValue, TTable extends RecordTable>(opts: {
  schema: RecordModule<TValue>
  table: TTable
  /** Business rules (./rules.ts); a returned string is the reason to drop it. */
  rules?: (value: TValue, at: RecordLocation) => string | undefined
  immutable?: boolean
  embeds?: (ref: { uri: string; did: string }) => EmbedTarget
  toRow: (
    value: TValue
  ) => Omit<TTable["$inferInsert"], "uri" | "cid" | "did" | "indexedAt">
}): CollectionHandler {
  const { schema, table } = opts
  return {
    collection: schema.$nsid,
    immutable: opts.immutable ?? false,
    embeds: opts.embeds,
    validate(at, record) {
      const parsed = schema.$safeParse(record)
      if (!parsed.success) return { ok: false, reason: parsed.message }
      const reason =
        checkRecordKey(schema.main.key, at.rkey) ??
        opts.rules?.(parsed.value, at)
      return reason ? { ok: false, reason } : { ok: true, value: parsed.value }
    },
    async upsert(tx, ref, value) {
      const row = {
        ...ref,
        ...opts.toRow(value as TValue),
        indexedAt: new Date(),
      } as TTable["$inferInsert"]
      const insert = tx.insert(table).values(row)
      await (opts.immutable
        ? insert.onConflictDoNothing({ target: table.uri })
        : insert.onConflictDoUpdate({ target: table.uri, set: row }))
    },
    async exists(tx, uri) {
      // Widened: drizzle's `from` cannot see through the generic table type.
      const source: PgTable = table
      const rows = await tx
        .select({ uri: table.uri })
        .from(source)
        .where(eq(table.uri, uri))
        .limit(1)
      return rows.length > 0
    },
    async delete(tx, uri) {
      await tx.delete(table).where(eq(table.uri, uri))
    },
    async prune(tx, did, keep) {
      await tx
        .delete(table)
        .where(
          keep.length
            ? and(eq(table.did, did), notInArray(table.uri, keep))
            : eq(table.did, did)
        )
    },
  }
}

/** Enforces the lexicon's `key` type, which record validation does not see. */
function checkRecordKey(key: string, rkey: string): string | undefined {
  if (key === "tid") {
    return isValidTid(rkey) ? undefined : `record key ${rkey} is not a TID`
  }
  if (key.startsWith("literal:")) {
    const expected = key.slice("literal:".length)
    return rkey === expected ? undefined : `record key must be ${expected}`
  }
  if (key === "nsid") {
    return isValidNsid(rkey) ? undefined : `record key ${rkey} is not an NSID`
  }
  return isValidRecordKey(rkey) ? undefined : `invalid record key ${rkey}`
}

/** Invalid records stay in the user's repo; the index just never shows them. */
export function logInvalid(uri: string, reason: string) {
  console.warn(`[indexer] dropped invalid record ${uri}: ${reason}`)
}
