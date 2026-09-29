# Authentiq

A professional network built on the [AT Protocol](https://atproto.com). Users
own their profiles, posts and job postings in their own repos. Authentiq is an
AppView and a set of feed generators on top.

- [Roadmap](docs/roadmap.md) — goals, phases, milestones
- [Phase notes](docs/phases/) — what each stage built, and how it was verified
- [ADR 0001](docs/adr/0001-appview-pds-split.md) — architecture, and what is public

## Layout

```
apps/web          TanStack Start UI + BFF                  :3000 (127.0.0.1)
apps/appview      Elysia: firehose indexer + XRPC API      :2584
apps/feedgen      Elysia: feed generators                  :2585
packages/lexicons sh.authentiq.* lexicons + codegen
packages/db       Drizzle schema (Postgres + pgvector)
packages/atproto  identity helpers, local network constants
packages/ai       Mistral client, model choices
packages/rules    business rules shared by AppView and web (salary transparency, protected terms)
packages/ui       shadcn/ui components
infra/            docker compose: postgres :5442, plc :2582, pds :2583
```

## Getting started

Requires bun and Docker.

```bash
bun install
bun run infra:env        # generate secrets + .env files (never overwrites)
bun run infra:up         # start postgres, plc, pds (first run builds plc, a few minutes)
bun run seed             # create demo accounts: alice.test … (password: "password")
bun run seed:talent      # 84 synthetic candidates tal-001.test … for search (needs dev running)
bun run seed:social      # communities, posts, threads, likes, follows (needs seed + seed:talent, dev running)
bun run seed:jobs        # 17 job postings + 7 deliberately invalid ones (needs seed + seed:talent, dev running)
bun run db:migrate       # apply AppView schema
bun run dev              # infra:up + all apps
bun run infra:status     # smoke check everything
```

Then open **http://127.0.0.1:3000** (not `localhost` — ATProto loopback OAuth
clients may only redirect to `127.0.0.1`) and sign in as `alice.test` /
`password`.

Verification scripts, all run against the live stack:

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
```

`verify:indexer` stops and restarts the indexer through the AppView's admin
routes, so it needs `ADMIN_TOKEN` in `apps/appview/.env`. `infra:env` generates
it for new setups. An existing `.env` needs the line added by hand, then an
AppView restart.

Resume parsing calls Mistral, so `verify:resume` and `eval:resume` need
`MISTRAL_API_KEY` in `apps/appview/.env` (the AppView reads it, and the eval
loads it from there). Each run costs well under a cent. `eval:resume` takes
`--verbose` (print every mismatch) and `--only 02,09` (a subset), and
`RESUME_PARSER_MODEL=…` compares another model. `fixtures:resumes` regenerates
the fixture files; their expected annotations are hand-written.

`verify:search`, `verify:agent` and `eval:search` need the talent corpus
(`bun run seed:talent`, idempotent, run with the stack up). `verify:search`
also uses `ADMIN_TOKEN`, to point the embedding client at a dead URL and back.
Embeddings use `mistral-embed-2312` and the agent uses the model in
`MODELS.recruitingAgent` (`packages/ai`); both read `MISTRAL_API_KEY` from
`apps/appview/.env`. The recruiting assistant is at
http://127.0.0.1:3000/recruit.

`seed:social` writes synthetic communities, posts and threads as the seeded
accounts (alice.test, bob.test, … and some `tal-*` people), so run `seed` and
`seed:talent` first. It is idempotent. `verify:social` uses `ADMIN_TOKEN` to
stop the indexer and backfill repos in a chosen order, and signs in to the
web app, so it needs `bun run dev`. Communities are at
http://127.0.0.1:3000/communities.

`seed:jobs` writes synthetic postings across currencies, pay periods and
workplace types as the seeded accounts and a few `tal-*` recruiters, plus
seven that break a salary-transparency rule on purpose. The PDS stores
those; the AppView never shows them. It is idempotent. `verify:jobs` needs
`seed:jobs`, `seed:talent` and `bun run dev`, and calls the recruiting agent
(so `MISTRAL_API_KEY`). The job board is at http://127.0.0.1:3000/jobs.

Other scripts: `infra:down`, `infra:reset` (wipes volumes), `infra:logs`,
`codegen`, `test` (unit tests), `typecheck`, `lint`.

## UI components

```bash
bunx shadcn@latest add button -c apps/web   # lands in packages/ui/src/components
```

```tsx
import { Button } from "@workspace/ui/components/button"
```
