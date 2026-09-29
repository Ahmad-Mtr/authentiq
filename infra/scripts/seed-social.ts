/**
 * Seeds the social layer (phase 6) with synthetic data: communities,
 * memberships, posts, threads several levels deep, likes and follows. All of
 * it is written to the local PDS, so it travels the real path:
 *
 *   PDS → firehose → indexer (validation, rules) → Postgres → AppView views
 *
 * The cast is existing accounts: `bun run seed` (alice.test, bob.test, …) and
 * `bun run seed:talent` (tal-NNN.test). No profiles are written, so talent
 * search and its eval are untouched.
 *
 * Two records are wrong on purpose, to show the AppView's rules at work:
 * dave.test posts into Platform Engineering without joining it (hidden from
 * the community, shown on his profile), and carol.test writes a post over
 * the 3000-grapheme limit (accepted by the PDS, never indexed).
 *
 * Idempotent, like seed:talent: record keys are deterministic TIDs and
 * `createdAt` is fixed, so a second run finds every record already in place
 * and writes nothing. Then it waits (polling, with a timeout) until the
 * index shows the expected state.
 *
 *   bun run seed:social
 */
import { join } from "node:path"
import { AtpAgent, RichText } from "@atproto/api"
import { SQL } from "bun"
import { LOCAL_NETWORK, isValidTid } from "@workspace/atproto"
import { sh } from "@workspace/lexicons"

const root = join(import.meta.dir, "..", "..")
const infraEnv = Object.fromEntries(
  (await Bun.file(join(root, "infra/.env")).text())
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
)
const PDS = process.env.PDS_URL ?? LOCAL_NETWORK.pdsUrl
const APPVIEW = process.env.APPVIEW_URL ?? LOCAL_NETWORK.appviewUrl
const PASSWORD = "password"
const WAIT_MS = 60_000

// --- the script ------------------------------------------------------------------

type Step =
  | {
      kind: "community"
      key: string
      by: string
      name: string
      topic: string
      description: string
      rules: Array<string>
    }
  | { kind: "join"; by: string; community: string }
  | {
      kind: "post"
      key: string
      by: string
      text: string
      community?: string
      replyTo?: string
      link?: { uri: string; title: string; description?: string }
      /** Written as-is, bypassing the lexicon: it is meant to be invalid. */
      invalid?: boolean
    }
  | { kind: "like"; by: string; post: string }
  | { kind: "follow"; by: string; subject: string }

const PE = "platform-engineering"
const DS = "design-systems"
const HIRING = "hiring"
const ARABIC = "arabic-engineers"

const STEPS: Array<Step> = [
  {
    kind: "community",
    key: PE,
    by: "alice.test",
    name: "Platform Engineering",
    topic: "Platform engineering",
    description:
      "Internal platforms, paved roads, on-call and the tooling that keeps product teams shipping. Long posts welcome.",
    rules: [
      "Stay on topic: platforms, infrastructure, reliability.",
      "Share what you learned, including what failed.",
      "No recruiting posts; there is a hiring community for that.",
    ],
  },
  {
    kind: "community",
    key: DS,
    by: "tal-035.test",
    name: "Design Systems",
    topic: "Design systems",
    description:
      "Tokens, components, documentation and the people work of keeping a design system alive.",
    rules: ["Show your work.", "Critique ideas, not people."],
  },
  {
    kind: "community",
    key: HIRING,
    by: "tal-075.test",
    name: "Hiring in the Open",
    topic: "Hiring",
    description:
      "Transparent hiring: salary ranges, honest process write-ups, and what candidates wish we knew.",
    rules: ["Every role you mention has a salary range."],
  },
  {
    kind: "community",
    key: ARABIC,
    by: "omar.test",
    name: "مهندسون بالعربية",
    topic: "الهندسة بالعربية",
    description:
      "نقاشات تقنية باللغة العربية: البنية التحتية، الواجهات، والبيانات.",
    rules: ["الاحترام أولاً.", "شارك المصادر عندما تستطيع."],
  },
  { kind: "join", by: "tal-030.test", community: PE },
  { kind: "join", by: "tal-028.test", community: PE },
  { kind: "join", by: "tal-003.test", community: PE },
  { kind: "join", by: "bob.test", community: PE },
  { kind: "join", by: "tal-034.test", community: DS },
  { kind: "join", by: "tal-009.test", community: DS },
  { kind: "join", by: "alice.test", community: DS },
  { kind: "join", by: "tal-073.test", community: HIRING },
  { kind: "join", by: "bob.test", community: HIRING },
  { kind: "join", by: "layla.test", community: HIRING },
  { kind: "join", by: "layla.test", community: ARABIC },
  { kind: "join", by: "noor.test", community: ARABIC },

  // A five-level thread in Platform Engineering.
  {
    kind: "post",
    key: "pe-oncall",
    by: "alice.test",
    community: PE,
    text: `We cut our on-call pages by 60% last quarter, and almost none of it came from new tooling.

What worked:
1. Every alert had to name the user-visible symptom it protects. About a third of ours could not, so we deleted them.
2. Anything that paged twice in a week without action got a ticket with an owner and a date.
3. We moved "disk will be full in 5 days" style alerts to a morning digest. They are real, but they are not 3 a.m. problems.

What did not work: a severity matrix. Nobody read it at 3 a.m.

Curious how others decide what deserves a page. @bob.test, you ran the payments rotation, how did you draw the line?`,
  },
  {
    kind: "post",
    key: "pe-oncall-r1",
    by: "tal-030.test",
    replyTo: "pe-oncall",
    text: `The "name the symptom" rule is the one I would steal. We did something similar with SLO burn rates: page on fast burn, ticket on slow burn. It forced the same conversation about what users actually feel.`,
  },
  {
    kind: "post",
    key: "pe-oncall-r2",
    by: "tal-028.test",
    replyTo: "pe-oncall-r1",
    text: `Burn-rate alerts helped us too, but only after we fixed the SLOs themselves. Our first ones were aspirational, so the budget was always on fire and people learned to ignore it.`,
  },
  {
    kind: "post",
    key: "pe-oncall-r3",
    by: "alice.test",
    replyTo: "pe-oncall-r2",
    text: `Same lesson here. We now set the first SLO at last quarter's actual performance and tighten it once the alerts are trusted.`,
  },
  {
    kind: "post",
    key: "pe-oncall-r4",
    by: "tal-003.test",
    replyTo: "pe-oncall-r3",
    text: `Starting from observed performance is underrated. It also gives product a real number to argue with instead of a vibe.`,
  },
  {
    kind: "post",
    key: "pe-oncall-r1b",
    by: "bob.test",
    replyTo: "pe-oncall",
    text: `For payments the line was money: anything that could double-charge or silently drop a payment paged, everything else waited for business hours. It made the rotation boring, which is the goal.`,
  },

  // A second Platform Engineering thread, with a link card.
  {
    kind: "post",
    key: "pe-paved-road",
    by: "tal-030.test",
    community: PE,
    text: `A paved road only works if it is the easiest path, not the mandated one. We measure adoption by how many new services pick the template without being asked. Write-up of how we got from 20% to 85%: https://example.com/paved-road`,
    link: {
      uri: "https://example.com/paved-road",
      title: "From 20% to 85%: making the paved road the easy road",
      description: "Templates, defaults and the things we stopped mandating.",
    },
  },

  // Design Systems: a thread with a reply from a non-member (replies are open).
  {
    kind: "post",
    key: "ds-tokens",
    by: "tal-035.test",
    community: DS,
    text: `Hot take: most design token debates are naming debates in disguise. We settled ours by naming tokens after intent ("surface-raised"), never after value ("grey-100"), and the arguments mostly stopped.`,
  },
  {
    kind: "post",
    key: "ds-tokens-r1",
    by: "tal-009.test",
    replyTo: "ds-tokens",
    text: `Intent names also make accessibility reviews easier: you can check every "text-on-surface" pair once instead of auditing hex codes screen by screen.`,
  },
  {
    kind: "post",
    key: "ds-tokens-r2",
    by: "tal-034.test",
    replyTo: "ds-tokens-r1",
    text: `We automated exactly that check in CI. Contrast failures now block the token change, not the release.`,
  },
  {
    kind: "post",
    key: "ds-tokens-r3",
    by: "bob.test",
    replyTo: "ds-tokens-r2",
    text: `Engineer passing through: this is the first design-systems practice I have seen that I would happily adopt on the backend side too. Contracts checked in CI beat contracts in a wiki.`,
  },

  // Hiring in the Open.
  {
    kind: "post",
    key: "hiring-ranges",
    by: "tal-075.test",
    community: HIRING,
    text: `We started publishing salary ranges on every role in January. Applications went down 15% and interviews that ended in an offer went up by half. Fewer people, better matched, and nobody wasted a final round on a number that was never going to work.`,
  },
  {
    kind: "post",
    key: "hiring-ranges-r1",
    by: "tal-073.test",
    replyTo: "hiring-ranges",
    text: `Same effect on our side. The ranges also shut down the awkward "what are your expectations" dance in the first call.`,
  },
  {
    kind: "post",
    key: "hiring-arabic",
    by: "layla.test",
    community: HIRING,
    text: `شكراً @omar.test على الدعوة 👋🏽 نبحث عن مهندس(ة) أنظمة دفع في دبي، والراتب بين ٢٥٬٠٠٠ و٣٢٬٠٠٠ درهم شهرياً 💼. التفاصيل: https://example.com/jobs/payments`,
  },

  // Arabic community.
  {
    kind: "post",
    key: "ar-welcome",
    by: "omar.test",
    community: ARABIC,
    text: `أهلاً بكم في المجتمع 🌙 هنا نكتب عن الهندسة بلغتنا. عرّفوا بأنفسكم: ما الذي تعملون عليه هذا الشهر؟`,
  },
  {
    kind: "post",
    key: "ar-welcome-r1",
    by: "noor.test",
    replyTo: "ar-welcome",
    text: `أعمل على نقل خدماتنا إلى Kubernetes، والتحدي الأكبر هو المراقبة وليس النقل نفسه 😅 @layla.test هل جربتِ OpenTelemetry؟`,
  },
  {
    kind: "post",
    key: "ar-welcome-r2",
    by: "layla.test",
    replyTo: "ar-welcome-r1",
    text: `نعم! ابدئي بالتتبع (traces) قبل المقاييس، النتائج أسرع بكثير ✨`,
  },

  // Posts outside any community.
  {
    kind: "post",
    key: "alice-longform",
    by: "alice.test",
    text: `Why I write long posts here instead of threads elsewhere: a thread of ten 280-character fragments optimises for the first fragment. A single long post optimises for the person who reads to the end.

Authentiq gives a post 3000 characters and no like count. I have found that changes what I bother to write.`,
  },

  // The non-member post: dave.test never joined Platform Engineering.
  {
    kind: "post",
    key: "pe-nonmember",
    by: "dave.test",
    community: PE,
    text: `Drive-by question for the platform folks: is anyone running Nomad in production in 2026? (I have not joined this community, so its members will not see this in it.)`,
  },

  // Over the limit on purpose: the PDS accepts it, the AppView drops it.
  {
    kind: "post",
    key: "over-length",
    by: "carol.test",
    invalid: true,
    text: `${"Long-form is welcome, but not this long. ".repeat(80)}`.slice(
      0,
      3100
    ),
  },

  { kind: "like", by: "bob.test", post: "pe-oncall" },
  { kind: "like", by: "tal-030.test", post: "pe-oncall" },
  { kind: "like", by: "alice.test", post: "pe-oncall-r1" },
  { kind: "like", by: "alice.test", post: "ds-tokens" },
  { kind: "like", by: "tal-035.test", post: "ds-tokens-r2" },
  { kind: "like", by: "omar.test", post: "hiring-arabic" },
  { kind: "like", by: "layla.test", post: "ar-welcome" },
  { kind: "like", by: "bob.test", post: "alice-longform" },

  { kind: "follow", by: "bob.test", subject: "alice.test" },
  { kind: "follow", by: "alice.test", subject: "tal-030.test" },
  { kind: "follow", by: "alice.test", subject: "tal-035.test" },
  { kind: "follow", by: "tal-028.test", subject: "tal-030.test" },
  { kind: "follow", by: "layla.test", subject: "omar.test" },
  { kind: "follow", by: "noor.test", subject: "omar.test" },
  { kind: "follow", by: "omar.test", subject: "layla.test" },
]

// --- deterministic keys and timestamps -------------------------------------------

/** Base32-sortable TID from a fixed timestamp, so record keys never change. */
const B32 = "234567abcdefghijklmnopqrstuvwxyz"
function tid(micros: bigint) {
  let v = micros << 10n
  let s = ""
  for (let i = 0; i < 13; i++) {
    s = B32[Number(v & 31n)] + s
    v >>= 5n
  }
  if (!isValidTid(s)) throw new Error(`bad tid ${s}`)
  return s
}
/** Step i happened 23 minutes after step i − 1, starting 2026-09-20 08:00 UTC. */
const BASE_MS = Date.parse("2026-09-20T08:00:00.000Z")
const at = (i: number) => {
  const ms = BASE_MS + i * 23 * 60 * 1000
  return {
    rkey: tid(BigInt(ms) * 1000n),
    createdAt: new Date(ms).toISOString(),
  }
}

// --- PDS access ---------------------------------------------------------------------

type Session = { did: string; jwt: string }
const sessions = new Map<string, Session>()

async function xrpc(
  method: string,
  opts: { body?: unknown; params?: Record<string, string>; auth?: string }
) {
  const url = new URL(`/xrpc/${method}`, PDS)
  for (const [k, v] of Object.entries(opts.params ?? {}))
    url.searchParams.set(k, v)
  const res = await fetch(url, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: {
      ...(opts.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return {
    ok: res.ok,
    body: (await res.json().catch(() => ({}))) as Record<string, any>,
  }
}

async function session(handle: string): Promise<Session> {
  const cached = sessions.get(handle)
  if (cached) return cached
  const res = await xrpc("com.atproto.server.createSession", {
    body: { identifier: handle, password: PASSWORD },
  })
  if (!res.ok) {
    throw new Error(
      `${handle}: ${res.body.message ?? res.body.error} — run \`bun run seed\` and \`bun run seed:talent\` first`
    )
  }
  const s = { did: res.body.did as string, jwt: `Bearer ${res.body.accessJwt}` }
  sessions.set(handle, s)
  return s
}

/** Key order does not matter to a record, so compare canonical JSON. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b))
        )
      : x
  )

let written = 0
let unchanged = 0

/** Makes `collection/rkey` in `handle`'s repo equal `record`; returns its ref. */
async function ensure(
  handle: string,
  collection: string,
  rkey: string,
  record: Record<string, unknown>
) {
  const s = await session(handle)
  const existing = await xrpc("com.atproto.repo.getRecord", {
    params: { repo: s.did, collection, rkey },
  })
  if (existing.ok && canonical(existing.body.value) === canonical(record)) {
    unchanged++
    return {
      uri: existing.body.uri as string,
      cid: existing.body.cid as string,
    }
  }
  if (existing.ok) {
    // Changed since the last run. Posts are create-only in the AppView, so
    // replace the record rather than update it.
    await xrpc("com.atproto.repo.deleteRecord", {
      body: { repo: s.did, collection, rkey },
      auth: s.jwt,
    })
  }
  const res = await xrpc("com.atproto.repo.createRecord", {
    body: { repo: s.did, collection, rkey, record },
    auth: s.jwt,
  })
  if (!res.ok) throw new Error(`${handle} ${collection}: ${res.body.message}`)
  written++
  return { uri: res.body.uri as string, cid: res.body.cid as string }
}

/** Mentions resolve to DIDs through the PDS, as the web composer does. */
const resolver = new AtpAgent({ service: PDS })
async function facetsFor(text: string) {
  const rt = new RichText({ text })
  await rt.detectFacets(resolver)
  const out = (rt.facets ?? []).flatMap((f) => {
    const features = f.features.flatMap((feature) => {
      if (feature.$type === "app.bsky.richtext.facet#mention") {
        const did = (feature as { did: string }).did
        return did
          ? [{ $type: "sh.authentiq.richtext.facet#mention", did }]
          : []
      }
      if (feature.$type === "app.bsky.richtext.facet#link") {
        const uri = (feature as { uri: string }).uri
        return [{ $type: "sh.authentiq.richtext.facet#link", uri }]
      }
      return []
    })
    return features.length ? [{ index: f.index, features }] : []
  })
  return out.length ? out : undefined
}

// --- run ------------------------------------------------------------------------

const refs = new Map<string, { uri: string; cid: string }>()
/** Every post's root, to build reply refs. */
const roots = new Map<string, { uri: string; cid: string }>()
const expected = {
  posts: [] as Array<string>,
  invalidPosts: [] as Array<string>,
  likes: [] as Array<string>,
  follows: [] as Array<string>,
  communities: [] as Array<string>,
  memberships: [] as Array<string>,
}

for (const [i, step] of STEPS.entries()) {
  const { rkey, createdAt } = at(i)
  switch (step.kind) {
    case "community": {
      const ref = await ensure(
        step.by,
        sh.authentiq.community.declaration.$nsid,
        rkey,
        sh.authentiq.community.declaration.$parse({
          $type: sh.authentiq.community.declaration.$type,
          name: step.name,
          topic: step.topic,
          description: step.description,
          rules: step.rules,
          createdAt,
        })
      )
      refs.set(step.key, ref)
      expected.communities.push(ref.uri)
      break
    }
    case "join": {
      const ref = await ensure(
        step.by,
        sh.authentiq.community.membership.$nsid,
        rkey,
        sh.authentiq.community.membership.$parse({
          $type: sh.authentiq.community.membership.$type,
          community: refs.get(step.community)!,
          createdAt,
        })
      )
      expected.memberships.push(ref.uri)
      break
    }
    case "post": {
      const parent = step.replyTo ? refs.get(step.replyTo)! : undefined
      const record = {
        $type: sh.authentiq.feed.post.$type,
        text: step.text,
        facets: await facetsFor(step.text),
        reply: parent ? { root: roots.get(step.replyTo!)!, parent } : undefined,
        community: step.community ? refs.get(step.community)! : undefined,
        embed: step.link
          ? { $type: sh.authentiq.embed.external.$type, external: step.link }
          : undefined,
        createdAt,
      }
      const ref = await ensure(
        step.by,
        sh.authentiq.feed.post.$nsid,
        rkey,
        step.invalid
          ? JSON.parse(JSON.stringify(record))
          : sh.authentiq.feed.post.$parse(record)
      )
      refs.set(step.key, ref)
      roots.set(step.key, parent ? roots.get(step.replyTo!)! : ref)
      ;(step.invalid ? expected.invalidPosts : expected.posts).push(ref.uri)
      break
    }
    case "like": {
      const ref = await ensure(
        step.by,
        sh.authentiq.feed.like.$nsid,
        rkey,
        sh.authentiq.feed.like.$parse({
          $type: sh.authentiq.feed.like.$type,
          subject: refs.get(step.post)!,
          createdAt,
        })
      )
      expected.likes.push(ref.uri)
      break
    }
    case "follow": {
      const ref = await ensure(
        step.by,
        sh.authentiq.graph.follow.$nsid,
        rkey,
        sh.authentiq.graph.follow.$parse({
          $type: sh.authentiq.graph.follow.$type,
          subject: (await session(step.subject)).did,
          createdAt,
        })
      )
      expected.follows.push(ref.uri)
      break
    }
  }
}
console.log(
  `✓ ${STEPS.length} records: ${written} written, ${unchanged} already up to date`
)

// --- wait for the index -------------------------------------------------------

const db = new SQL(
  `postgres://authentiq:${infraEnv.POSTGRES_PASSWORD}@localhost:${infraEnv.POSTGRES_PORT ?? 5442}/authentiq`
)
const count = async (table: string, uris: Array<string>) =>
  uris.length === 0
    ? 0
    : ((
        await db.unsafe(
          `select count(*)::int as n from ${table} where uri in (${uris.map((_, i) => `$${i + 1}`).join(", ")})`,
          uris
        )
      )[0].n as number)

const started = performance.now()
let last = ""
for (;;) {
  const n = {
    communities: await count("community", expected.communities),
    memberships: await count("membership", expected.memberships),
    posts: await count("post", expected.posts),
    likes: await count("post_like", expected.likes),
    follows: await count("follow", expected.follows),
  }
  const status = Object.entries(n)
    .map(([k, v]) => `${v}/${expected[k as keyof typeof n].length} ${k}`)
    .join(", ")
  if (status !== last) console.log(`  indexed: ${status}`)
  last = status
  if (
    Object.entries(n).every(
      ([k, v]) => v === expected[k as keyof typeof n].length
    )
  ) {
    break
  }
  if (performance.now() - started > WAIT_MS) {
    console.log(
      `✗ timed out after ${WAIT_MS / 1000} s — is the AppView running (bun run dev)?`
    )
    await db.close()
    process.exit(1)
  }
  await Bun.sleep(250)
}
const leaked = await count("post", expected.invalidPosts)
await db.close()
if (leaked > 0) {
  console.log(`✗ the over-length post was indexed`)
  process.exit(1)
}
console.log(
  `✓ social data indexed (${Math.round(performance.now() - started)} ms); the over-length post was dropped, as intended`
)

// The non-member's post is indexed but not shown in the community.
const community = refs.get(PE)!.uri
const res = await fetch(
  `${APPVIEW}/xrpc/sh.authentiq.community.getPosts?community=${encodeURIComponent(community)}`
)
const shown = (
  (await res.json()) as { feed?: Array<{ post: { uri: string } }> }
).feed?.map((f) => f.post.uri)
if (shown?.includes(refs.get("pe-nonmember")!.uri)) {
  console.log("✗ the non-member's post is shown in Platform Engineering")
  process.exit(1)
}
console.log(
  `✓ Platform Engineering shows ${shown?.length ?? 0} thread(s); dave.test's non-member post is not among them`
)
