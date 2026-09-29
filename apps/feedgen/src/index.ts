import { eq, sql } from "drizzle-orm"
import { Elysia, status, t } from "elysia"
import { AtUri } from "@workspace/atproto"
import { schema } from "@workspace/db"
import { sh } from "@workspace/lexicons"
import { ALGOS, AlgoError } from "./algos.ts"
import { verifyViewer } from "./auth.ts"
import { db } from "./db.ts"
import { env } from "./env.ts"

/**
 * Feed generator service (phase 8). Deliberately separate from the AppView:
 * it only returns feed *skeletons* (references to posts and job postings, in
 * order). The AppView resolves this service from a generator record, calls
 * it, and hydrates the result under its own policy.
 *
 * Its identity is `did:web:localhost%3A2585`: the DID document below names
 * the `#authentiq_fg` endpoint the AppView calls. It holds no key, because
 * this service never signs anything; it is only ever the *audience* of
 * viewers' service auth tokens (src/auth.ts), which it checks against the
 * viewers' own keys.
 */

const FEED = sh.authentiq.feed

/** The publisher's DID, from its handle in the index, once it is known. */
let publisher: string | undefined
async function publisherDid() {
  if (publisher) return publisher
  if (env.PUBLISHER.startsWith("did:")) return (publisher = env.PUBLISHER)
  const [row] = await db
    .select({ did: schema.actor.did })
    .from(schema.actor)
    .where(eq(schema.actor.handle, env.PUBLISHER.toLowerCase()))
  return (publisher = row?.did)
}

const feedUri = (did: string, rkey: string) =>
  `at://${did}/${FEED.generator.$nsid}/${rkey}`

const app = new Elysia()
  .get("/xrpc/_health", async () => {
    try {
      await db.execute(sql`select 1`)
      return {
        service: "feedgen",
        version: "0.0.1",
        did: env.SERVICE_DID,
        db: "ok (read-only)",
        publisher: (await publisherDid()) ?? null,
      }
    } catch {
      return status(503, { service: "feedgen", db: "unreachable" })
    }
  })
  .get("/.well-known/did.json", () => ({
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: env.SERVICE_DID,
    service: [
      {
        id: "#authentiq_fg",
        type: "AuthentiqFeedGenerator",
        serviceEndpoint: env.PUBLIC_URL,
      },
    ],
  }))
  .get(`/xrpc/${FEED.describeFeedGenerator.$lxm}`, async () => {
    const did = await publisherDid()
    return FEED.describeFeedGenerator.$output.schema.parse({
      did: env.SERVICE_DID,
      feeds: did
        ? Object.keys(ALGOS).map((rkey) => ({ uri: feedUri(did, rkey) }))
        : [],
    })
  })
  .get(
    `/xrpc/${FEED.getFeedSkeleton.$lxm}`,
    async ({ query, headers }) => {
      let uri: AtUri
      try {
        uri = new AtUri(query.feed)
      } catch {
        return status(400, { error: "InvalidRequest", message: "feed is not an AT-URI" })
      }
      const algo = ALGOS[uri.rkey]
      if (
        !algo ||
        uri.collection !== FEED.generator.$nsid ||
        uri.host !== (await publisherDid())
      ) {
        return status(400, {
          error: "UnknownFeed",
          message: "This service does not serve that feed",
        })
      }
      const auth = await verifyViewer(headers.authorization)
      if (!("viewer" in auth)) return status(401, auth)
      try {
        return FEED.getFeedSkeleton.$output.schema.parse(
          await algo({
            viewer: auth.viewer,
            limit: query.limit ?? 50,
            cursor: query.cursor,
          })
        )
      } catch (err) {
        if (err instanceof AlgoError) {
          return status(err.status, { error: err.error, message: err.message })
        }
        throw err
      }
    },
    {
      query: t.Object({
        feed: t.String({ maxLength: 8192 }),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
        cursor: t.Optional(t.String({ maxLength: 512 })),
      }),
    }
  )
  .listen(env.PORT)

console.log(`feedgen listening on http://localhost:${app.server?.port}`)
