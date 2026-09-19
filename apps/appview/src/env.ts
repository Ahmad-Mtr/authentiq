import { z } from "zod"
import { LOCAL_NETWORK } from "@workspace/atproto"

export const env = z
  .object({
    PORT: z.coerce.number().default(2584),
    DATABASE_URL: z.url(),
    PDS_URL: z.url().default(LOCAL_NETWORK.pdsUrl),
    PLC_URL: z.url().default(LOCAL_NETWORK.plcUrl),
    WEB_ORIGIN: z.url().default("http://localhost:3000"),
  })
  .parse(process.env)
