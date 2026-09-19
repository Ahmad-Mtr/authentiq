# @workspace/lexicons

Source of truth for the `app.authentiq.*` schema. JSON lexicons live in
`lexicons/` (one file per NSID, path mirrors the NSID). TypeScript validators
and types are generated into `src/generated/` (git-ignored) by
[`@atproto/lex`](https://www.npmjs.com/package/@atproto/lex).

```bash
bun run codegen                                   # lexicons/ → src/generated/
bun run lexicons:install com.atproto.repo.strongRef  # vendor an external lexicon
```

Turbo runs `codegen` automatically before `dev`, `build` and `typecheck`.

## Rules

- **Evolve, don't break.** Published records live in users' repos forever. Only
  add optional fields. Never make a field required or change its type; add a
  new NSID instead.
- **The PDS does not validate our lexicons.** It accepts unknown record types as
  `validationStatus: "unknown"`. The AppView validates every record against these
  schemas (plus business rules such as salary transparency) before indexing it.
