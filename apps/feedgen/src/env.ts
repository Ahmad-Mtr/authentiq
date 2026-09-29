import { z } from "zod"
import { LOCAL_NETWORK } from "@workspace/atproto"

export const env = z
  .object({
    PORT: z.coerce.number().default(2585),
    /**
     * The read-only `feedgen_reader` role (infra/scripts/db-roles.ts): SELECT
     * on the AppView's index tables, nothing else.
     */
    DATABASE_URL: z.url(),
    /** did:web identity; the audience of viewers' service auth tokens. */
    SERVICE_DID: z.string().default("did:web:localhost%3A2585"),
    /** Where this service is reached, for its DID document. */
    PUBLIC_URL: z.url().default(LOCAL_NETWORK.feedgenUrl),
    /** The account whose feed.generator records this service answers for. */
    PUBLISHER: z.string().default("authentiq-feeds.test"),
    PLC_URL: z.url().default(LOCAL_NETWORK.plcUrl),
  })
  .parse(process.env)
