/**
 * Portability demo: "you own your data", shown with nothing but the
 * protocol. It never talks to the AppView or our database.
 *
 *   1. export alice's whole repo as a CAR file (com.atproto.sync.getRepo)
 *   2. read the commit at its root: which DID, which revision, the signature
 *   3. fetch her DID document from PLC and take the signing key it names
 *   4. check the commit signature with that key (and that a one-bit change
 *      to the signature fails)
 *   5. verify the whole repo: signature plus the Merkle search tree that
 *      proves every record belongs to that commit
 *   6. list every record by collection
 *
 * Anyone can do this for any account, with public endpoints only. The CAR is
 * written to a temp file, so it can be copied to another PDS or AppView.
 *
 *   bun run demo:portability                  # alice.test
 *   bun run demo:portability -- bob.test
 */
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cborToLex,
  cborToLexRecord,
  readCarWithRoot,
  verifyCommitSig,
  verifyRepoCar,
} from "@atproto/repo"
import type { Commit } from "@atproto/repo"
import { LOCAL_NETWORK } from "@workspace/atproto"

const PDS = process.env.PDS_URL ?? LOCAL_NETWORK.pdsUrl
const PLC = process.env.PLC_URL ?? LOCAL_NETWORK.plcUrl
const handle = process.argv[2] ?? "alice.test"

let failures = 0
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures++
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`)
}
const step = (title: string) => console.log(`\n${title}`)

step(`1. export ${handle}'s repo from its PDS`)
const resolved = await fetch(
  `${PDS}/xrpc/com.atproto.identity.resolveHandle?handle=${handle}`
).then((r) => r.json() as Promise<{ did?: string }>)
if (!resolved.did) {
  console.log(`✗ ${handle} not found on ${PDS} — run bun run seed`)
  process.exit(1)
}
const did = resolved.did
const res = await fetch(`${PDS}/xrpc/com.atproto.sync.getRepo?did=${did}`)
const car = new Uint8Array(await res.arrayBuffer())
const file = join(tmpdir(), `${handle}.car`)
await Bun.write(file, car)
check(res.ok, "GET com.atproto.sync.getRepo", `${car.length.toLocaleString()} bytes → ${file}`)

step("2. the commit at the CAR's root")
const { root, blocks } = await readCarWithRoot(car)
const commit = cborToLex(blocks.get(root)!) as unknown as Commit
console.log(`  root  ${root.toString()}`)
console.log(`  did   ${commit.did}`)
console.log(`  rev   ${commit.rev}   (a TID: the repo's revision)`)
console.log(`  data  ${commit.data.toString()}   (the Merkle search tree root)`)
console.log(`  sig   ${Buffer.from(commit.sig).toString("base64url").slice(0, 32)}… (${commit.sig.length} bytes)`)
check(commit.did === did, "the commit names the account's DID", did)

step("3. the signing key, from the DID document on PLC")
const doc = (await fetch(`${PLC}/${did}`).then((r) => r.json())) as {
  alsoKnownAs?: Array<string>
  verificationMethod?: Array<{ id: string; publicKeyMultibase: string }>
  service?: Array<{ id: string; serviceEndpoint: string }>
}
const method = doc.verificationMethod?.find((m) => m.id.endsWith("#atproto"))
const didKey = method ? `did:key:${method.publicKeyMultibase}` : undefined
console.log(`  ${PLC}/${did}`)
console.log(`  alsoKnownAs  ${doc.alsoKnownAs?.join(", ")}`)
console.log(`  #atproto     ${didKey}`)
console.log(
  `  #atproto_pds ${doc.service?.find((s) => s.id === "#atproto_pds")?.serviceEndpoint}`
)
check(Boolean(didKey), "the DID document names a signing key")

step("4. the commit signature")
check(
  await verifyCommitSig(commit, didKey!),
  "the signature verifies against that key"
)
const tampered = { ...commit, sig: new Uint8Array(commit.sig) }
tampered.sig[0]! ^= 1
check(
  !(await verifyCommitSig(tampered, didKey!).catch(() => false)),
  "flipping one bit of the signature makes it fail"
)

step("5. the whole repo: signature, tree and every record")
const verified = await verifyRepoCar(car, did, didKey)
check(
  verified.commit.rev === commit.rev,
  "verifyRepoCar accepts it: every record is proven to belong to this signed commit",
  `${verified.creates.length} records`
)

step("6. what is inside, by collection")
const byCollection = new Map<string, Array<{ rkey: string; record: Record<string, unknown> }>>()
for (const entry of verified.creates) {
  const bytes = verified.commit.newBlocks.get(entry.cid)
  if (!bytes) continue
  const list = byCollection.get(entry.collection) ?? []
  list.push({ rkey: entry.rkey, record: cborToLexRecord(bytes) as Record<string, unknown> })
  byCollection.set(entry.collection, list)
}
const summary = (collection: string, r: Record<string, unknown>): string => {
  const s = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").slice(0, 60)
  switch (collection.split(".").slice(-2).join(".")) {
    case "actor.profile":
      return `${s(r.displayName)} · ${s(r.headline)} · openToWork: ${r.openToWork}`
    case "actor.position":
      return `${s(r.title)} @ ${s(r.organization)} (${r.startDate}–${r.endDate ?? "now"})`
    case "actor.education":
      return `${s(r.degree)} ${s(r.fieldOfStudy)}, ${s(r.school)}`
    case "feed.post":
      return `${r.reply ? "↳ " : r.community ? "▣ " : ""}${s(r.text)}`
    case "feed.like":
      return `♥ ${(r.subject as { uri: string }).uri}`
    case "graph.follow":
      return `→ ${s(r.subject)}`
    case "community.declaration":
      return `${s(r.name)} (topic: ${s(r.topic)})`
    case "community.membership":
      return `member of ${(r.community as { uri: string }).uri}`
    case "job.posting": {
      const pay = r.salary as { min: number; max: number; currency: string; period: string } | undefined
      return `${s(r.title)} · ${pay ? `${pay.currency} ${pay.min}–${pay.max} per ${pay.period}` : "NO SALARY (in the repo, never shown by the AppView)"}`
    }
    default:
      return s(JSON.stringify(r))
  }
}
for (const [collection, records] of [...byCollection].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`\n  ${collection} (${records.length})`)
  for (const { rkey, record } of records.slice(0, 6)) {
    console.log(`    ${rkey.padEnd(14)} ${summary(collection, record)}`)
  }
  if (records.length > 6) console.log(`    … ${records.length - 6} more`)
}

console.log(
  `\n${failures ? `✗ ${failures} check(s) failed` : `✓ ${handle}'s professional identity, social graph and postings: one signed file, verified with public keys only`}`
)
process.exit(failures ? 1 : 0)
