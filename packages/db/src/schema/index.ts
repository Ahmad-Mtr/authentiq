import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"

/**
 * Small key/value store for service bookkeeping, e.g. the AppView's firehose
 * cursor (`firehose:cursor`) so indexing resumes where it left off.
 */
export const serviceState = pgTable("service_state", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})
