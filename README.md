# Authentiq

A professional network built on the [AT Protocol](https://atproto.com). Users
own their profiles, posts and job postings in their own repos. Authentiq is an
AppView and a set of feed generators on top.

## Start here

- [The write-up](docs/writeup.md): what this is, why it is built this way,
  what it measured and what is unfinished, for engineers new to ATProto
- [Demo walkthrough](docs/demo.md): a new user's first session, step by step, about 20 minutes
- [Evals](docs/evals.md), [threat model](docs/threat-model.md),
  [architecture](docs/architecture.md), [open decisions](docs/open-decisions.md)
- [Roadmap](docs/roadmap.md) — goals, phases, milestones
- [Phase notes](docs/phases/) — what each stage built, and how it was verified
- [ADR 0001](docs/adr/0001-appview-pds-split.md) — architecture, and what is public

## Layout

```
apps/web          TanStack Start UI + BFF                  :3000 (127.0.0.1)
apps/appview      Elysia: firehose indexer + XRPC API      :2584
apps/feedgen      Elysia: first-party feed generators      :2585 (read-only Postgres role)
apps/feedgen-thirdparty  a third party's feed generator  :2586 (public firehose only)
packages/lexicons sh.authentiq.* lexicons + codegen
packages/db       Drizzle schema (Postgres + pgvector)
packages/atproto  identity helpers, local network constants
packages/ai       Mistral client, model choices
packages/rules    business rules shared by AppView and web (salary transparency, protected terms)
packages/ui       shadcn/ui components
infra/            docker compose: postgres :5442, plc :2582, pds :2583
```

## Getting started

Requires bun, Docker and a Mistral API key (resume parsing, embeddings and
the recruiting agent all call Mistral).

```bash
bun install
bun run infra:env        # generate secrets + .env files (never overwrites)
```

Put your key in `apps/appview/.env` (`MISTRAL_API_KEY=…`), then:

```bash
bun run infra:up         # start postgres, plc, pds (first run builds plc, a few minutes)
bun run db:migrate       # apply AppView schema, and create the feedgen's read-only role
bun run seed             # create demo accounts: alice.test … (password: "password")
bun run dev              # all apps; leave it running and use a second terminal
```

The remaining seeds wait until the AppView has indexed what they write, so
they need `bun run dev` running. In a second terminal, in this order:

```bash
bun run seed:talent      # 84 synthetic candidates tal-001.test … for search and its eval
bun run seed:social      # communities, posts, threads, likes, follows
bun run seed:jobs        # 17 job postings + 8 deliberately invalid ones
bun run seed:feeds       # feed generator records, a third party's feed, follows and pins
bun run seed:demo        # the LLM-generated demo cast: people, communities, threads, jobs
bun run infra:status     # smoke check everything
bun run verify:all       # every verify and eval script, with a summary table
```

Then open **http://127.0.0.1:3000** (not `localhost` — ATProto loopback OAuth
clients may only redirect to `127.0.0.1`) and sign in as `alice.test` /
`password`.

**Demo accounts:** every account the seed scripts create uses the password
`password`: `alice.test` … `noor.test`, the `tal-NNN.test` candidates, the
demo cast, and the feed publishers (`authentiq-feeds.test`,
`link-roundup.test`). These are credentials for the local PDS only.

Verification and eval scripts, all run against the live stack.
`bun run verify:all` runs every one of them in dependency order and prints a
table: result, checks, duration and the model cost it measured (from the
AppView's token counters). A full run takes about 4 minutes and costs about
$0.25, most of it `eval:agent` and the agent checks on Mistral Medium.

```bash
bun run verify:lexicons  # validators + a record round-trip through the PDS
bun run verify:oauth     # the whole sign-in flow, headlessly
bun run verify:indexer   # firehose → index → getProfile, invalid records, restart, backfill
bun run verify:resume    # resume upload → draft → confirm, auth, privacy, injection, file checks
bun run eval:resume      # parser accuracy on infra/fixtures/resumes: precision/recall per field
bun run verify:search    # embed on write, re-embed on change only, filters, fusion, API outage
bun run verify:agent     # agent auth, streamed tool calls, citations, hostile profile, protected attributes
bun run eval:search      # nDCG@10 / recall@10 / MRR for vector, FTS and hybrid on 28 labelled queries
bun run verify:social    # posts, threads, out-of-order indexing, facets, invalid records, no counts, communities, hiding, deactivation
bun run verify:jobs      # the salary-less curl demo, invalid postings, edit/delete, salary floor across periods, close dates,
                         # deactivation, similar candidates, match score privacy, the agent's get_job
bun run verify:feeds     # record → DID → endpoint, following, viewer tokens, jobs-for-you, the AppView overriding a
                         # skeleton, failing generators, SSRF, cursors, pins, and the third-party feed
bun run eval:agent       # 18 scripted prompts: citation validity, protected-attribute refusals, unrequested filters
bun run eval:bias        # counterfactual pairs (gender, religion, age, a name) through search, match bands, similar candidates
bun run verify:all       # all of the above, with a summary table
```

Demos (see [docs/demo.md](docs/demo.md)):

```bash
bun run demo:portability # export alice's repo as a CAR, verify its signature against PLC, list every record
bun run demo:replay      # empty the AppView, rebuild it from the repos, diff; lists what does not come back
```

`verify:indexer` stops and restarts the indexer through the AppView's admin
routes, so it needs `ADMIN_TOKEN` in `apps/appview/.env`. `infra:env` generates
it for new setups. An existing `.env` needs the line added by hand, then an
AppView restart.

Resume parsing calls Mistral, so `verify:resume` and `eval:resume` need
`MISTRAL_API_KEY` in `apps/appview/.env` (the AppView reads it, and the eval
loads it from there). Each run costs about $0.05 on Mistral Medium. `eval:resume` takes
`--verbose` (print every mismatch) and `--only 02,09` (a subset), and
`RESUME_PARSER_MODEL=…` compares another model. `fixtures:resumes` regenerates
the fixture files; their expected annotations are hand-written.

`verify:search`, `verify:agent` and `eval:search` need the talent corpus
(`bun run seed:talent`, idempotent, run with the stack up). `verify:search`
also uses `ADMIN_TOKEN`, to point the embedding client at a dead URL and back.
Embeddings use `mistral-embed-2312`; resume parsing and the agent use
`mistral-medium-2604` (`MODELS` in `packages/ai`, chosen by the phase 9
evals); all read `MISTRAL_API_KEY` from `apps/appview/.env`.
`RECRUITING_AGENT_MODEL=…` makes `eval:agent` compare another model. The recruiting assistant is at
http://127.0.0.1:3000/recruit.

`seed:social` writes synthetic communities, posts and threads as the seeded
accounts (alice.test, bob.test, … and some `tal-*` people), so run `seed` and
`seed:talent` first. It is idempotent. `verify:social` uses `ADMIN_TOKEN` to
stop the indexer and backfill repos in a chosen order, and signs in to the
web app, so it needs `bun run dev`. Communities are at
http://127.0.0.1:3000/communities.

`seed:jobs` writes synthetic postings across currencies, pay periods and
workplace types as the seeded accounts and a few `tal-*` recruiters, plus
seven that break a salary-transparency rule on purpose, and restores the
salary-less posting phase 0 wrote into alice's repo. The PDS stores
those; the AppView never shows them. It is idempotent. `verify:jobs` needs
`seed:jobs`, `seed:talent` and `bun run dev`, and calls the recruiting agent
(so `MISTRAL_API_KEY`). The job board is at http://127.0.0.1:3000/jobs.

`seed:feeds` creates `authentiq-feeds.test`, which publishes the four
first-party `sh.authentiq.feed.generator` records (following, my communities,
jobs for you, industry pulse), adds follows, and pins two feeds for
alice.test. It also runs the third party's own publish script
(`apps/feedgen-thirdparty`, `link-roundup.test`, "Posts with a link").
`bun run dev` starts both feed generators. `db:migrate` creates the
`feedgen_reader` role the first-party generator connects as, and points
`apps/feedgen/.env` at it the first time. `verify:feeds` runs scripted
generators and a canary on ports 2590–2594 and 2599, which the AppView's
`FETCH_ALLOW` development allowlist names; `THIRDPARTY_BASE=<git tree>`
additionally checks the third-party step's diff. Feeds are at
http://127.0.0.1:3000/feeds, and pinned feeds are tabs on the home page.

`seed:demo` replays the generated demo cast in `infra/fixtures/demo/`: 54
fictional people, five communities with threads, likes, follows and 18 job
postings, plus alice.test's positions and education. It calls no model, and
is idempotent. `fixtures:demo` regenerated those files with Mistral once
(`-- --audit` re-prints their diversity audit); the prompts, model and
audit are in `infra/fixtures/demo/meta.json`. The demo cast is separate from
the eval corpora, but it is indexed like everyone else, so it shares the
search pool: `eval:search` reports "judged only" figures for that reason
([docs/evals.md](docs/evals.md)).

`bun run seed` also writes alice.test's profile (the one phase 2 wrote by
hand), because the phase 5–8 evals ran with it in the index.

Other scripts: `infra:down`, `infra:reset` (wipes volumes), `infra:logs`,
`codegen`, `test` (unit tests), `typecheck`, `lint`.

## UI components

```bash
bunx shadcn@latest add button -c apps/web   # lands in packages/ui/src/components
```

```tsx
import { Button } from "@workspace/ui/components/button"
```
