import { IdResolver, MemoryCache } from "@atproto/identity"
import { and, eq, ne } from "drizzle-orm"
import { schema } from "@workspace/db"
import {
  getHandle,
  getPdsEndpoint,
  isValidHandle,
  resolveDid,
  resolveHandle,
} from "@workspace/atproto"
import { env } from "../env.ts"
import { guardedFetch } from "../fetch.ts"
import type { Tx } from "./collections.ts"

/**
 * Used by `@atproto/sync` to fetch signing keys and verify commits, through
 * the local PLC, and by service auth (src/auth.ts) to fetch the key of a
 * token's `iss`, which is whatever DID the caller wrote into the token. Its
 * default fetch adds SSRF protection that cannot run under Bun (it throws
 * "requires Node.js 20.6+"). Until phase 8 it got the global fetch, so a
 * forged token naming `did:web:10.0.0.1` made the AppView fetch that host.
 * It now gets the fetch guard (src/fetch.ts).
 */
export const idResolver = new IdResolver({
  plcUrl: env.PLC_URL,
  didCache: new MemoryCache(),
  fetch: guardedFetch,
})

/**
 * Resolves a DID through the local PLC and verifies its handle both ways:
 * the DID document claims the handle, and the handle resolves back to the DID.
 * `*.test` handles have no DNS, so the second leg asks the actor's PDS.
 */
export async function resolveIdentity(
  did: string
): Promise<{ handle: string | null; pds: string }> {
  const doc = await resolveDid(did, { plcUrl: env.PLC_URL, fetch: guardedFetch })
  const pds = getPdsEndpoint(doc) ?? env.PDS_URL
  const claimed = getHandle(doc)?.toLowerCase()
  if (!claimed || !isValidHandle(claimed)) return { handle: null, pds }
  try {
    const resolved = await resolveHandle(claimed, {
      pdsUrl: pds,
      fetch: guardedFetch,
    })
    return { handle: resolved === did ? claimed : null, pds }
  } catch {
    return { handle: null, pds }
  }
}

type ActorFields = Partial<
  Pick<
    typeof schema.actor.$inferInsert,
    "handle" | "active" | "status" | "rev" | "backfilledAt"
  >
>

/** Creates or updates an actor row. Fields left undefined are not touched. */
export async function upsertActor(tx: Tx, did: string, fields: ActorFields) {
  // A handle belongs to one DID. If another actor still holds it (we missed
  // or have not yet seen their handle change), the newer claim wins.
  if (fields.handle) {
    await tx
      .update(schema.actor)
      .set({ handle: null })
      .where(
        and(eq(schema.actor.handle, fields.handle), ne(schema.actor.did, did))
      )
  }
  await tx
    .insert(schema.actor)
    .values({ did, ...fields })
    .onConflictDoUpdate({
      target: schema.actor.did,
      set: { ...fields, indexedAt: new Date() },
    })
}
