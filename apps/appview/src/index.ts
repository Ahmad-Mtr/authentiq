import { cors } from "@elysiajs/cors"
import { createDb, sql } from "@workspace/db"
import { Elysia, status } from "elysia"
import { env } from "./env.ts"

const db = createDb(env.DATABASE_URL)

const app = new Elysia()
  .use(cors({ origin: env.WEB_ORIGIN }))
  .get("/xrpc/_health", async () => {
    try {
      await db.execute(sql`select 1`)
      return { service: "appview", version: "0.0.1", db: "ok" }
    } catch {
      return status(503, { service: "appview", db: "unreachable" })
    }
  })
  .listen(env.PORT)

console.log(`appview listening on http://localhost:${app.server?.port}`)
