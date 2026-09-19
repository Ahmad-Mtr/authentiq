import { defineConfig } from "drizzle-kit"

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is not set (run `bun run infra:env`)")

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: { url },
})
