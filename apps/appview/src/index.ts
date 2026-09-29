import { cors } from "@elysiajs/cors"
import { sql } from "@workspace/db"
import { Elysia, status } from "elysia"
import { admin } from "./admin.ts"
import { db } from "./db.ts"
import { env } from "./env.ts"
import { createIndexer } from "./indexer/index.ts"
import { startDraftSweeper } from "./resume/drafts.ts"
import { getProfile } from "./xrpc/getProfile.ts"
import { resume } from "./xrpc/resume.ts"

const indexer = createIndexer()

const app = new Elysia()
  .use(cors({ origin: env.WEB_ORIGIN }))
  .use(getProfile)
  .use(resume)
  .use(env.ADMIN_TOKEN ? admin(indexer) : new Elysia())
  // did:web document, so the DID service auth tokens are addressed to
  // resolves to this service.
  .get("/.well-known/did.json", () => ({
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: env.SERVICE_DID,
    service: [
      {
        id: "#authentiq_appview",
        type: "AuthentiqAppView",
        serviceEndpoint: `http://localhost:${env.PORT}`,
      },
    ],
  }))
  .get("/xrpc/_health", async () => {
    try {
      await db.execute(sql`select 1`)
      const { running, cursor } = indexer.status()
      return {
        service: "appview",
        version: "0.0.1",
        db: "ok",
        indexer: { running, cursor },
      }
    } catch {
      return status(503, { service: "appview", db: "unreachable" })
    }
  })
  .listen(env.PORT)

console.log(`appview listening on http://localhost:${app.server?.port}`)

await indexer.start()
const stopSweeper = startDraftSweeper()

// Let in-flight events finish so the saved cursor is exact on shutdown.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    stopSweeper()
    await indexer.stop()
    process.exit(0)
  })
}
