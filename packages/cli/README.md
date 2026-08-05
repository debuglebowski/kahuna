# `km` — the Kingsmaker command line

```
km <noun> [<sub-noun>] <verb> [target] [--flags]
```

```bash
km auth login --host https://kingsmaker.example.com
km record list vendor --where status=active --json | jq '.[].label'
km record import vendor vendors.csv --key name
km concept create Supplier
km access check --user <id> --action edit --resource concept --id <id>
```

## The grammar

**Every command names the thing that owns the row.** A relation edge belongs to
a record, so it is `record relation add`; a relation *type* is a field on a
concept, so it is `concept field add --kind relation`.

**The first token after a noun is a verb or a sub-noun — never an id.** Ids come
after the verb. That is what makes `task status list` (the status catalogue)
unambiguous next to `task update <id> --status done` (one task's status).

**One verb set:** `list · get · create · update · delete · archive · restore`,
plus domain verbs where the domain has one (`publish`, `transition`, `sync`,
`assign`, `deactivate`). A verb means the same thing under every noun: `delete`
always purges, `archive` is always reversible.

Run `km help` for the full list, or `km <command> --help` for one.

## Output

Data on **stdout**, everything else on **stderr** — `km … --json | jq` never has
to filter our chatter. `--json`, `--csv`, or an aligned table by default.

| exit | meaning |
| --- | --- |
| 0 | fine |
| 1 | failed |
| 2 | you typed something wrong |
| 3 | not signed in |
| 4 | not allowed |
| 5 | not found |
| 6 | conflict (something changed underneath, or is still in use) |

## Profiles

Credentials live in `$XDG_CONFIG_HOME/kingsmaker/config.json` (mode 0600).

```bash
km profile add production --host https://kingsmaker.example.com
km profile use production
km record list vendor --profile local     # one command, other deployment
```

`KM_HOST` overrides the host without touching the stored profile, and
`KM_PROFILE` picks one — both meant for CI.

## What it cannot do yet

- **SSO sign-in.** The browser round trip sets a cookie on the *server's* origin
  and hands the CLI nothing, so there is no credential to capture. An SSO-only
  organization has no CLI path until token credentials land.
- **Unattended CI.** Same reason: a session cookie expires, and `km auth token
  create` needs BetterAuth's API-key plugin server-side.
- **Filter or sort on the server.** `listRecords` takes a concept and nothing
  else, so `--where` / `--sort` / `--limit` run client-side over the whole set,
  which the server caps at 50 000 records. Above that the CLI says so rather
  than returning a truncated list that looks complete.

## Development

```bash
bun run --cwd packages/cli test      # unit tests, no server needed
bun run cli:build                    # bundle for Node -> dist/index.js
bun run --cwd packages/app scripts/verify-cli.ts   # end-to-end, needs a live server
```

The CLI targets **Node**, not Bun: `@types/bun` is deliberately absent, and
TypeScript that emits (parameter properties, enums) breaks
`node --experimental-strip-types` even though it typechecks. CI builds the
bundle and smoke-tests it with plain `node` for exactly that reason.
