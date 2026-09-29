import { and, eq, notInArray } from "drizzle-orm"
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core"
import type { Database } from "@workspace/db"
import { isValidNsid, isValidRecordKey, isValidTid } from "@workspace/atproto"

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

export type RecordRef = { uri: string; cid: string; did: string }

export type Validation =
  { ok: true; value: unknown } | { ok: false; reason: string }

/** How the indexer treats one record collection. */
export type CollectionHandler = {
  collection: string
  /** Lexicon validation, then the record-key shape, then business rules. */
  validate: (rkey: string, record: unknown) => Validation
  upsert: (tx: Tx, ref: RecordRef, value: unknown) => Promise<void>
  delete: (tx: Tx, uri: string) => Promise<void>
  /** Backfill: drop this actor's rows whose URIs are no longer in the repo. */
  prune: (tx: Tx, did: string, keep: Array<string>) => Promise<void>
}

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
  rules?: (value: TValue) => string | undefined
  toRow: (
    value: TValue
  ) => Omit<TTable["$inferInsert"], "uri" | "cid" | "did" | "indexedAt">
}): CollectionHandler {
  const { schema, table } = opts
  return {
    collection: schema.$nsid,
    validate(rkey, record) {
      const parsed = schema.$safeParse(record)
      if (!parsed.success) return { ok: false, reason: parsed.message }
      const reason =
        checkRecordKey(schema.main.key, rkey) ?? opts.rules?.(parsed.value)
      return reason ? { ok: false, reason } : { ok: true, value: parsed.value }
    },
    async upsert(tx, ref, value) {
      const row = {
        ...ref,
        ...opts.toRow(value as TValue),
        indexedAt: new Date(),
      } as TTable["$inferInsert"]
      await tx
        .insert(table)
        .values(row)
        .onConflictDoUpdate({ target: table.uri, set: row })
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
