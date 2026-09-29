import { z } from "zod"
import { LOCAL_NETWORK } from "@workspace/atproto"

export const env = z
  .object({
    PORT: z.coerce.number().default(2584),
    DATABASE_URL: z.url(),
    PDS_URL: z.url().default(LOCAL_NETWORK.pdsUrl),
    PLC_URL: z.url().default(LOCAL_NETWORK.plcUrl),
    WEB_ORIGIN: z.url().default("http://localhost:3000"),
    /** did:web identity; the audience of service auth tokens (phase 4). */
    SERVICE_DID: z.string().default("did:web:localhost%3A2584"),
    /** Firehose to index. Defaults to the local PDS's subscribeRepos endpoint. */
    FIREHOSE_URL: z.url().optional(),
    /**
     * Development override for the fetch guard (src/fetch.ts): `host:port`
     * or `host:lo-hi` entries that may be fetched over http and may resolve
     * to loopback. The local feed generators (2585, 2586) and the ports
     * `verify:feeds` runs its scripted generators on (2590–2594). PLC and
     * PDS hosts are added from their URLs. Leave empty in a deployment.
     */
    FETCH_ALLOW: z.string().default("localhost:2585-2586,localhost:2590-2594"),
    /** Bearer token for /_admin/*. The admin routes are disabled when unset. */
    ADMIN_TOKEN: z.string().min(16).optional(),
  })
  .transform((e) => ({
    ...e,
    FIREHOSE_URL: e.FIREHOSE_URL ?? e.PDS_URL.replace(/^http/, "ws"),
  }))
  .parse(process.env)
