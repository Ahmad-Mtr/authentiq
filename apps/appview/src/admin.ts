import { timingSafeEqual } from "node:crypto"
import { Elysia, status, t } from "elysia"
import { env } from "./env.ts"
import type { Indexer } from "./indexer/index.ts"

/**
 * Operator routes for the indexer, behind `Authorization: Bearer $ADMIN_TOKEN`.
 * Not mounted at all when ADMIN_TOKEN is unset. `bun run verify:indexer` uses
 * stop/start to prove the saved cursor survives a restart.
 */
export const admin = (indexer: Indexer) =>
  new Elysia({ prefix: "/_admin" })
    .onBeforeHandle(({ headers }) => {
      if (!authorized(headers.authorization)) {
        return status(401, { error: "Unauthorized" })
      }
    })
    .get("/indexer", () => indexer.status())
    .post("/indexer/start", () => indexer.start())
    .post("/indexer/stop", () => indexer.stop())
    .post(
      "/backfill",
      async ({ body }) => {
        await indexer.backfill(body.did)
        return { did: body.did, backfilled: true }
      },
      { body: t.Object({ did: t.String({ pattern: "^did:" }) }) }
    )

function authorized(header: string | undefined) {
  if (!env.ADMIN_TOKEN || !header) return false
  const given = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${env.ADMIN_TOKEN}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
