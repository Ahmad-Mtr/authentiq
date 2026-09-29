import { createDb } from "@workspace/db"
import { env } from "./env.ts"

/** Connected as `feedgen_reader`: read-only, index tables only. */
export const db = createDb(env.DATABASE_URL)
