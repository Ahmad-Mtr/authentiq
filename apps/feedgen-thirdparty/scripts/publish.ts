/**
 * Publishes this service's feed, as its operator would: an account on the
 * network (created here if it does not exist yet), and one
 * `sh.authentiq.feed.generator` record in its repo naming this service's
 * DID. Written through the PDS like any record; nothing is registered with
 * Authentiq, which finds the feed on the firehose. Idempotent.
 *
 *   bun run publish-feed        (and part of `bun run seed:feeds`)
 */
import { env } from "../src/env.ts"

const PASSWORD = "password"
const RKEY = "with-links"
const RECORD = {
  $type: "sh.authentiq.feed.generator",
  did: env.SERVICE_DID,
  displayName: "Posts with a link",
  description:
    "Every post that links somewhere, newest first. Run by a third party, from the public firehose.",
  createdAt: "2026-09-28T12:00:00.000Z",
}

async function xrpc(method: string, opts: { body?: unknown; params?: Record<string, string>; auth?: string } = {}) {
  const url = new URL(`/xrpc/${method}`, env.PDS_URL)
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v)
  const res = await fetch(url, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return { ok: res.ok, body: (await res.json().catch(() => ({}))) as Record<string, any> }
}

let session = await xrpc("com.atproto.server.createSession", {
  body: { identifier: env.PUBLISHER, password: PASSWORD },
})
if (!session.ok) {
  session = await xrpc("com.atproto.server.createAccount", {
    body: {
      handle: env.PUBLISHER,
      email: `${env.PUBLISHER.replace(/\.test$/, "")}@authentiq.test`,
      password: PASSWORD,
    },
  })
  if (!session.ok) throw new Error(`createAccount ${env.PUBLISHER}: ${session.body.message}`)
  console.log(`✓ created ${env.PUBLISHER} ${session.body.did}`)
}
const did = session.body.did as string
const auth = `Bearer ${session.body.accessJwt}`

const existing = await xrpc("com.atproto.repo.getRecord", {
  params: { repo: did, collection: RECORD.$type, rkey: RKEY },
})
const same =
  existing.ok &&
  JSON.stringify(Object.entries(existing.body.value).sort()) ===
    JSON.stringify(Object.entries(RECORD).sort())
if (same) {
  console.log(`✓ ${env.PUBLISHER} already publishes at://${did}/${RECORD.$type}/${RKEY}`)
} else {
  const put = await xrpc("com.atproto.repo.putRecord", {
    body: { repo: did, collection: RECORD.$type, rkey: RKEY, record: RECORD },
    auth,
  })
  if (!put.ok) throw new Error(`putRecord: ${put.body.message}`)
  console.log(`✓ ${env.PUBLISHER} published ${put.body.uri} → ${env.SERVICE_DID}`)
}
