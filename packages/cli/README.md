# `kahuna` — the Kahuna command line

```
kahuna <noun> [<sub-noun>] <verb> [target] [--flags]
```

```bash
kahuna auth login --host https://kahuna.example.com
kahuna record list vendor --where status=active --json | jq '.[].label'
kahuna record import vendor vendors.csv --key name
kahuna concept create Supplier
kahuna access check --user <id> --action edit --resource concept --id <id>
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

Run `kahuna help` for the full list, `kahuna <command> --help` for one, and
`kahuna --version` (or `-v`) for the CLI's own version — no network and no
sign-in. That last one is deliberately not `kahuna system version`, which asks the
DEPLOYMENT what it is running and warns if the two have drifted.

## Output

Data on **stdout**, everything else on **stderr** — `kahuna … --json | jq` never has
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

## Configuration

One deployment, stored in `$XDG_CONFIG_HOME/kahuna/config.json` (mode 0600):

```json
{ "host": "https://kahuna.example.com", "cookie": "…", "email": "you@example.com" }
```

`kahuna auth login --host <url>` writes it; every later command reads it. **There is
no default host** — an unconfigured CLI says so rather than quietly trying
`localhost`. `KAHUNA_HOST` overrides it without touching the file, which is what CI
wants.

## Signing in through the browser

```bash
kahuna auth login --browser     # or --sso, which is the same thing
```

```
  Open:  https://kahuna.example.com/api/cli/device?code=WDJB-MJHT
```

The CLI prints a link and waits. Open it in **any browser, on any machine** —
your laptop, your phone — and sign in however this deployment allows (password,
SSO, anything). Opening the link is the approval; there is nothing to type. The
CLI is polling, and continues on its own.

Nothing is redirected anywhere and nothing listens on a local port, which is
deliberate: the usual loopback-redirect flow needs the browser and the CLI on
the same machine, so it breaks over ssh, in a devcontainer, or any time you would
rather open the link on your phone. The CLI never talks to your identity
provider either, which is why this works where a CLI-driven SSO flow cannot.

The credential is the browser's session, so **signing out in the browser signs
the CLI out too**. That goes away when token credentials land.

## Keeping the CLI current

```bash
kahuna cli update            # upgrade to the newest published version
kahuna cli update --dry-run  # print what it would run, change nothing
```

**Why this matters more than it looks.** The CLI carries a *copy* of the wire
contract, compiled in at build time. Against a deployment built from newer
sources, a procedure whose shape changed fails inside a schema decode with a
message about a field nobody typed. `kahuna system version` detects that skew and
says "update the CLI first"; this is how you do it.

`kahuna cli update` asks **npm** what the newest `@kahunalabs/cli` is and upgrades a
global install in place, with no prompt. `kahuna system version` asks your
**deployment** what image it runs — different artifact, different registry. Set
`KAHUNA_REGISTRY` to point at a mirror.

It works out which package manager owns the install from where the binary
actually lives (`npm`, `bun`, `pnpm`, `yarn`) and **refuses** in three cases,
naming the command to run instead:

| where it is | why it refuses |
| --- | --- |
| a source checkout or `npm link` | installing would write over a working tree |
| a project dependency | it would rewrite that project's lockfile, and the CLI's CWD is not reliably that project's root |
| an `npx` cache | it is ephemeral; there is nothing installed to update |

The package manager's output goes to **stderr** with all other chatter, so
`kahuna cli update --json` stays parseable.

## What it cannot do yet

- **Unattended CI.** A session expires, and `kahuna auth token create` needs
  BetterAuth's API-key plugin server-side. Until then, CI needs a
  password-capable account and `kahuna auth login --email --password`.
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

The bundle is ~620 KB, ~190 KB installed, with no dependencies. Effect is about
80% of that: the wire contract is defined with `effect/Schema` and the client is
`@effect/rpc`, so the CLI carries the server's runtime in order to speak its
format. That is the price of one shared contract and no drift, and it is a price
paid once at install.

The CLI targets **Node**, not Bun: `@types/bun` is deliberately absent, and
TypeScript that emits (parameter properties, enums) breaks
`node --experimental-strip-types` even though it typechecks. CI builds the
bundle and smoke-tests it with plain `node` for exactly that reason.
