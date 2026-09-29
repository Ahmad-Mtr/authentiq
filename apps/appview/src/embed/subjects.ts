import { eq } from "drizzle-orm"
import { schema } from "@workspace/db"
import { db } from "../db.ts"
import type { Tx } from "../indexer/collections.ts"
import {
  DOCUMENT_VERSION,
  JOB_DOCUMENT_VERSION,
  buildJobDocument,
  buildProfileDocument,
} from "./document.ts"

/**
 * What can be embedded. Each kind knows how to load its canonical document
 * from the index; the queue, worker, hashing and storage are shared. Phase 7
 * added `job` (subject = the posting's AT-URI) with its own document builder.
 */
export type SubjectKind = {
  /** The document, or null when the subject should not be searchable. */
  load: (subject: string) => Promise<string | null>
  /** The builder's version, part of the hash: bumping it re-embeds this kind only. */
  version: number
}

export const subjectKinds: Record<string, SubjectKind> = {
  /** Subject is the actor's DID. Inactive actors and actors without a profile record are not searchable. */
  actor: {
    version: DOCUMENT_VERSION,
    async load(did) {
      const [row] = await db
        .select({ active: schema.actor.active, profile: schema.profile })
        .from(schema.actor)
        .leftJoin(schema.profile, eq(schema.profile.did, schema.actor.did))
        .where(eq(schema.actor.did, did))
      if (!row?.active || !row.profile) return null
      const [positions, education] = await Promise.all([
        db.select().from(schema.position).where(eq(schema.position.did, did)),
        db.select().from(schema.education).where(eq(schema.education.did, did)),
      ])
      return buildProfileDocument({
        profile: row.profile,
        positions,
        education,
      })
    },
  },
  /**
   * Subject is the posting's AT-URI. A posting whose author is inactive, or
   * that is no longer indexed (deleted, or edited into an invalid record),
   * has no document. Closed postings keep theirs: their authors can still
   * look for similar candidates.
   */
  job: {
    version: JOB_DOCUMENT_VERSION,
    async load(uri) {
      const [row] = await db
        .select({ active: schema.actor.active, job: schema.jobPosting })
        .from(schema.jobPosting)
        .innerJoin(schema.actor, eq(schema.actor.did, schema.jobPosting.did))
        .where(eq(schema.jobPosting.uri, uri))
      if (!row?.active) return null
      return buildJobDocument(row.job)
    },
  },
}

/**
 * Queues a subject for (re)embedding. Called by the indexer inside the same
 * transaction as the record write, so a committed change is never missed.
 * Cheap and model-free: the worker does the rest.
 */
export async function markDirty(
  tx: Tx,
  kind: string,
  subject: string,
  did: string
) {
  const now = new Date()
  await tx
    .insert(schema.embedding)
    .values({ subject, kind, did, dirtyAt: now, nextAttemptAt: now })
    .onConflictDoUpdate({
      target: schema.embedding.subject,
      set: { dirtyAt: now, nextAttemptAt: now, attempts: 0 },
    })
}

/**
 * Queues every subject an actor already has, so a backfill or reactivation
 * also reconsiders subjects whose records are gone.
 */
export async function markExistingDirty(tx: Tx, did: string) {
  const now = new Date()
  await tx
    .update(schema.embedding)
    .set({ dirtyAt: now, nextAttemptAt: now, attempts: 0 })
    .where(eq(schema.embedding.did, did))
}

/**
 * Reactivation: queues the actor's profile and every posting they have, whose
 * rows `removeActorEmbeddings` deleted on deactivation.
 */
export async function markActorSubjectsDirty(tx: Tx, did: string) {
  await markDirty(tx, "actor", did, did)
  const postings = await tx
    .select({ uri: schema.jobPosting.uri })
    .from(schema.jobPosting)
    .where(eq(schema.jobPosting.did, did))
  for (const { uri } of postings) await markDirty(tx, "job", uri, did)
}

/** Deactivation or takedown: their vectors and documents go at once. */
export async function removeActorEmbeddings(tx: Tx, did: string) {
  await tx.delete(schema.embedding).where(eq(schema.embedding.did, did))
}
