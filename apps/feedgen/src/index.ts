import { Elysia } from "elysia"
import { env } from "./env.ts"

/**
 * Feed generator service. Deliberately separate from the AppView: it only
 * returns feed *skeletons* (lists of post AT-URIs). The AppView hydrates them.
 */
const app = new Elysia()
  .get("/xrpc/_health", () => ({
    service: "feedgen",
    version: "0.0.1",
    did: env.SERVICE_DID,
  }))
  .listen(env.PORT)

console.log(`feedgen listening on http://localhost:${app.server?.port}`)
