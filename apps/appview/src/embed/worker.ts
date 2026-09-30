import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import {
  EMBEDDING_DIMENSIONS,
  MODELS,
  getMistral,
  getMistralServerURL,
  mistralRetries,
  recordUsage,
  setMistralServerURL,
} from "@workspace/ai"
import { schema } from "@workspace/db"
import { db } from "../db.ts"
import { hashDocument } from "./document.ts"
import { subjectKinds } from "./subjects.ts"

/**
 * Drains the embedding queue (`embedding.dirtyAt`), outside the firehose
 * path. For each dirty subject it rebuilds the document and stores it, which
 * keeps full-text search current straight away, then embeds it only if the
 * hash changed. A failed model call leaves the rows dirty and backs off
 * (2 s, 4 s, … capped at 5 min, per row), so an outage delays vectors and
 * loses nothing.
 */

const TICK_MS = 1000
const BATCH_SIZE = 8
/** Keeps one request well inside mistral-embed's token limit. */
const BATCH_CHARS = 24_000
const MAX_BACKOFF_MS = 5 * 60 * 1000

// Compile-time guard: the pgvector column and the model must agree on the
// dimension. Both are literal types, so changing one alone fails typecheck.
const dimensionsMatch: typeof EMBEDDING_DIMENSIONS =
  schema.EMBEDDING_COLUMN_DIMENSIONS
void dimensionsMatch

type Row = typeof schema.embedding.$inferSelect

export function createEmbedder() {
  const stats = {
    /** Embedding API requests made (successful or not). */
    calls: 0,
    embedded: 0,
    unchanged: 0,
    removed: 0,
    failures: 0,
    tokens: 0,
    lastError: null as string | null,
  }
  let timer: ReturnType<typeof setInterval> | undefined
  let busy = false

  async function tick() {
    if (busy) return
    busy = true
    try {
      // Keep going while there is a full batch due.
      while ((await drainOnce()) === BATCH_SIZE) {
        /* next batch */
      }
    } catch (err) {
      console.error("[embed] worker error:", (err as Error).message)
    } finally {
      busy = false
    }
  }

  async function drainOnce(): Promise<number> {
    const due = await db
      .select()
      .from(schema.embedding)
      .where(
        and(
          isNotNull(schema.embedding.dirtyAt),
          or(
            isNull(schema.embedding.nextAttemptAt),
            lte(schema.embedding.nextAttemptAt, new Date())
          )
        )
      )
      .orderBy(asc(schema.embedding.dirtyAt))
      .limit(BATCH_SIZE)
    if (due.length === 0) return 0

    const toEmbed: Array<{ row: Row; document: string; hash: string }> = []
    let chars = 0
    for (const row of due) {
      const kind = subjectKinds[row.kind]
      const document = kind ? await kind.load(row.subject) : null
      // Only settle a row if nothing re-dirtied it while we worked.
      const unchangedSince = and(
        eq(schema.embedding.subject, row.subject),
        eq(schema.embedding.dirtyAt, row.dirtyAt!)
      )
      if (document === null) {
        await db.delete(schema.embedding).where(unchangedSince)
        stats.removed++
        continue
      }
      const hash = hashDocument(MODELS.embedding, document, kind!.version)
      if (hash === row.embeddedHash && row.vector) {
        await db
          .update(schema.embedding)
          .set({
            document,
            contentHash: hash,
            dirtyAt: null,
            attempts: 0,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(unchangedSince)
        stats.unchanged++
        continue
      }
      // The new document is searchable by FTS now; the vector follows.
      await db
        .update(schema.embedding)
        .set({ document, contentHash: hash, updatedAt: new Date() })
        .where(eq(schema.embedding.subject, row.subject))
      if (toEmbed.length > 0 && chars + document.length > BATCH_CHARS) continue
      chars += document.length
      toEmbed.push({ row, document, hash })
    }
    if (toEmbed.length === 0) return due.length

    stats.calls++
    try {
      const res = await getMistral().embeddings.create(
        { model: MODELS.embedding, inputs: toEmbed.map((t) => t.document) },
        { timeoutMs: 30_000, ...mistralRetries(10_000) }
      )
      stats.tokens += res.usage.promptTokens ?? 0
      recordUsage(MODELS.embedding, res.usage)
      for (const [i, { row, hash }] of toEmbed.entries()) {
        const vector =
          res.data.find((d) => d.index === i)?.embedding ??
          res.data[i]?.embedding
        if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(`embedding ${i} missing or wrong size`)
        }
        await db
          .update(schema.embedding)
          .set({
            vector,
            embeddedHash: hash,
            model: MODELS.embedding,
            embedCount: sql`${schema.embedding.embedCount} + 1`,
            embeddedAt: new Date(),
            attempts: 0,
            lastError: null,
            nextAttemptAt: null,
            // Re-dirtied mid-flight? Leave it dirty for the next pass.
            dirtyAt: sql`case when ${schema.embedding.dirtyAt} = ${row.dirtyAt!.toISOString()}::timestamptz then null else ${schema.embedding.dirtyAt} end`,
            updatedAt: new Date(),
          })
          .where(eq(schema.embedding.subject, row.subject))
        stats.embedded++
      }
      console.log(
        `[embed] embedded ${toEmbed.length} subject(s), ${res.usage.promptTokens ?? 0} tokens`
      )
    } catch (err) {
      stats.failures++
      stats.lastError = errorName(err)
      for (const { row } of toEmbed) {
        const attempts = row.attempts + 1
        const delay = Math.min(2000 * 2 ** (attempts - 1), MAX_BACKOFF_MS)
        await db
          .update(schema.embedding)
          .set({
            attempts,
            nextAttemptAt: new Date(Date.now() + delay),
            lastError: stats.lastError,
          })
          .where(eq(schema.embedding.subject, row.subject))
      }
      console.warn(
        `[embed] batch of ${toEmbed.length} failed (${stats.lastError}); rows stay queued and back off`
      )
    }
    return due.length
  }

  // dirtyAt is compared for equality against the value read back into a JS
  // Date, so it must never carry more than millisecond precision: set it from
  // JS, or truncate as below.

  /**
   * Queues what predates this worker: every indexed actor with a profile and
   * every indexed job posting (phase 7) that has no embedding row, and every
   * vector made by another model.
   */
  async function enqueueMissing() {
    const queued = await db.execute(sql`
      insert into embedding (subject, kind, did, dirty_at, next_attempt_at)
      select p.did, 'actor', p.did, date_trunc('milliseconds', now()), now()
      from profile p join actor a on a.did = p.did and a.active
      on conflict (subject) do nothing`)
    const jobs = await db.execute(sql`
      insert into embedding (subject, kind, did, dirty_at, next_attempt_at)
      select j.uri, 'job', j.did, date_trunc('milliseconds', now()), now()
      from job_posting j join actor a on a.did = j.did and a.active
      on conflict (subject) do nothing`)
    await db
      .update(schema.embedding)
      .set({ dirtyAt: new Date(), nextAttemptAt: new Date() })
      .where(
        and(
          isNotNull(schema.embedding.vector),
          sql`${schema.embedding.model} is distinct from ${MODELS.embedding}`
        )
      )
    const n = (queued as unknown as { count?: number }).count ?? 0
    if (n > 0)
      console.log(`[embed] queued ${n} actor(s) indexed before embeddings`)
    const j = (jobs as unknown as { count?: number }).count ?? 0
    if (j > 0)
      console.log(`[embed] queued ${j} job posting(s) not yet embedded`)
  }

  return {
    async start() {
      if (timer) return
      await enqueueMissing()
      timer = setInterval(() => void tick(), TICK_MS)
      void tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    async status() {
      const [row] = await db
        .select({
          pending: sql<number>`count(*) filter (where ${schema.embedding.dirtyAt} is not null)::int`,
          embedded: sql<number>`count(*) filter (where ${schema.embedding.vector} is not null)::int`,
        })
        .from(schema.embedding)
      return {
        running: timer !== undefined,
        model: MODELS.embedding,
        serverURL: getMistralServerURL() ?? "default",
        pending: row?.pending ?? 0,
        embeddedSubjects: row?.embedded ?? 0,
        ...stats,
      }
    },
    /**
     * Admin: point the client elsewhere (a dead URL simulates an outage), or
     * back with `undefined`, and retry everything queued now.
     */
    async setServerURL(url: string | undefined) {
      setMistralServerURL(url)
      await db
        .update(schema.embedding)
        .set({ nextAttemptAt: new Date() })
        .where(isNotNull(schema.embedding.dirtyAt))
      void tick()
    },
  }
}

export type Embedder = ReturnType<typeof createEmbedder>

/** An error's type and HTTP status: never the message, which can echo input. */
function errorName(err: unknown) {
  const e = err as {
    name?: string
    statusCode?: number
    cause?: { code?: string }
  }
  return [e.name ?? "Error", e.statusCode, e.cause?.code]
    .filter(Boolean)
    .join(" ")
}
