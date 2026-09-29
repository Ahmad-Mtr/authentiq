import { z } from "zod"
import { LOCAL_NETWORK } from "@workspace/atproto"

export const env = z
  .object({
    PORT: z.coerce.number().default(2584),
    DATABASE_URL: z.url(),
    PDS_URL: z.url().default(LOCAL_NETWORK.pdsUrl),
    PLC_URL: z.url().default(LOCAL_NETWORK.plcUrl),
    WEB_ORIGIN: z.url().default("http://localhost:3000"),
    /** Firehose to index. Defaults to the local PDS's subscribeRepos endpoint. */
    FIREHOSE_URL: z.url().optional(),
    /** Bearer token for /_admin/*. The admin routes are disabled when unset. */
    ADMIN_TOKEN: z.string().min(16).optional(),
  })
  .transform((e) => ({
    ...e,
    FIREHOSE_URL: e.FIREHOSE_URL ?? e.PDS_URL.replace(/^http/, "ws"),
  }))
  .parse(process.env)
