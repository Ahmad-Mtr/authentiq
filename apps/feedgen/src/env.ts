import { z } from "zod"

export const env = z
  .object({
    PORT: z.coerce.number().default(2585),
    DATABASE_URL: z.url(),
    // did:web identity of this feed generator (published in Phase 8).
    SERVICE_DID: z.string().default("did:web:localhost%3A2585"),
  })
  .parse(process.env)
