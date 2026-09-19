import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema/index.ts"

export function createDb(url: string) {
  const client = postgres(url)
  return drizzle(client, { schema, casing: "snake_case" })
}

export type Database = ReturnType<typeof createDb>

export { schema }
export { sql } from "drizzle-orm"
