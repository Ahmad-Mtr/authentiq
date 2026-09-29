import { randomBytes } from "node:crypto"
import { and, eq, gt, lt } from "drizzle-orm"
import { schema } from "@workspace/db"
import type { sh } from "@workspace/lexicons"
import { db } from "../db.ts"

/**
 * Resume drafts: the structured parse, kept only for the review step. One per
 * user; a new upload replaces the previous draft. Deleted on confirm or
 * discard, and swept once expired. Expired rows are never served, even
 * before the sweep reaches them.
 */

export const DRAFT_TTL_MS = 30 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000

type Draft = sh.authentiq.resume.defs.Draft

export async function saveDraft(did: string, draft: Draft) {
  const id = randomBytes(18).toString("base64url")
  const expiresAt = new Date(Date.now() + DRAFT_TTL_MS)
  await db.transaction(async (tx) => {
    await tx.delete(schema.resumeDraft).where(eq(schema.resumeDraft.did, did))
    await tx.insert(schema.resumeDraft).values({ id, did, draft, expiresAt })
  })
  return { id, expiresAt }
}

/** The draft, if it exists, belongs to `did` and has not expired. */
export async function getDraft(did: string, id: string) {
  const [row] = await db
    .select()
    .from(schema.resumeDraft)
    .where(
      and(
        eq(schema.resumeDraft.id, id),
        eq(schema.resumeDraft.did, did),
        gt(schema.resumeDraft.expiresAt, new Date())
      )
    )
  return row && { ...row, draft: row.draft as Draft }
}

export async function deleteDraft(did: string, id: string) {
  const deleted = await db
    .delete(schema.resumeDraft)
    .where(and(eq(schema.resumeDraft.id, id), eq(schema.resumeDraft.did, did)))
    .returning({ id: schema.resumeDraft.id })
  return deleted.length > 0
}

export async function sweepExpiredDrafts() {
  const swept = await db
    .delete(schema.resumeDraft)
    .where(lt(schema.resumeDraft.expiresAt, new Date()))
    .returning({ id: schema.resumeDraft.id })
  return swept.length
}

/** Sweeps now and then every minute. Returns a stop function. */
export function startDraftSweeper() {
  const sweep = () =>
    sweepExpiredDrafts().catch((err: unknown) =>
      console.error("[resume] draft sweep failed:", (err as Error).message)
    )
  void sweep()
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS)
  return () => clearInterval(timer)
}
