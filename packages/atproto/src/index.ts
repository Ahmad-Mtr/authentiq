export {
  AtUri,
  isValidHandle,
  isValidNsid,
  ensureValidDid,
  currentDatetimeString,
} from "@atproto/syntax"
export * from "./identity.ts"

/** Default endpoints of the local network started by `bun run infra:up`. */
export const LOCAL_NETWORK = {
  plcUrl: "http://localhost:2582",
  pdsUrl: "http://localhost:2583",
  appviewUrl: "http://localhost:2584",
  feedgenUrl: "http://localhost:2585",
} as const

/** Every record type we own lives under this NSID authority. */
export const NSID_PREFIX = "sh.authentiq."
