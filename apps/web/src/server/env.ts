import { z } from "zod"
import { LOCAL_NETWORK } from "@workspace/atproto"

/** Server-only configuration. Never import this from a component. */
export const env = z
  .object({
    WEB_ORIGIN: z.url().default("http://127.0.0.1:3000"),
    DATABASE_URL: z.url(),
    PDS_URL: z.url().default(LOCAL_NETWORK.pdsUrl),
    PLC_URL: z.url().default(LOCAL_NETWORK.plcUrl),
    APPVIEW_URL: z.url().default(LOCAL_NETWORK.appviewUrl),
  })
  .parse(process.env)
