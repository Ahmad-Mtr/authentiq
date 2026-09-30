import { timingSafeEqual } from "node:crypto"
import { usageTotals } from "@workspace/ai"
import { Elysia, status, t } from "elysia"
import { env } from "./env.ts"
import type { Embedder } from "./embed/worker.ts"
import type { Indexer } from "./indexer/index.ts"

/**
 * Operator routes for the indexer and the embedding worker, behind
 * `Authorization: Bearer $ADMIN_TOKEN`. Not mounted at all when ADMIN_TOKEN is
 * unset. `bun run verify:indexer` uses stop/start to prove the saved cursor
 * survives a restart; `bun run verify:search` points the embedding client at
 * a dead URL to prove an outage delays vectors without blocking indexing.
 * `bun run verify:all` reads `/usage` before and after each script to report
 * what the model calls the AppView made on its behalf cost.
 */
export const admin = (indexer: Indexer, embedder: Embedder) =>
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
    .get("/embedder", () => embedder.status())
    .get("/usage", () => usageTotals())
    .post(
      "/embedder/endpoint",
      async ({ body }) => {
        await embedder.setServerURL(body.url)
        return embedder.status()
      },
      // Omit url to go back to Mistral.
      {
        body: t.Object({
          url: t.Optional(t.String({ pattern: "^https?://" })),
        }),
      }
    )

function authorized(header: string | undefined) {
  if (!env.ADMIN_TOKEN || !header) return false
  const given = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${env.ADMIN_TOKEN}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
