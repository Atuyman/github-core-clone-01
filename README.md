# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Atuyman/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Atuyman/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible forge in one process, no UI: git smart HTTP, REST v3, GraphQL v4
and MCP, all backed by its own in-memory object store. Built for
[the contest](https://make.fun/bounty/github-core-clone-01). Stdlib only — no git
binary, no package manager, no outside service.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own modules only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: discover, initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## How it is built

- **Git smart HTTP** (`git.ts`, `gitobj.ts`): upload-pack v2 (ls-refs, fetch, shallow,
  deepen) with a v0 fallback, and receive-pack v0 (unpack-then-judge, fast-forward rule,
  sideband report). Pack codec with ofs/ref deltas, written and read from scratch;
  pack reads find each zlib stream's end with one inflate plus an Adler-32 scan.
- **REST v3** (`rest.ts`): repos, branches, commits, contents (create/update/delete on
  born and unborn repos), labels, issues, comments, pull requests with real squash
  merges and conflict detection. Bearer auth on every route except the API root and
  `/meta`; every reply carries `X-GitHub-Request-Id`.
- **GraphQL v4** (`graphql.ts`): a minimal parser + executor for the fixed document set
  (viewer, repository, node, issues with cursor pagination, pull requests, the five
  mutations, introspection, batching). Unknown fields answer HTTP 200 with an `errors`
  array naming the field.
- **MCP** (`mcp.ts`): JSON-RPC 2.0 Streamable HTTP — modern-era `discover`
  (2026-07-28), `initialize`, `tools/list` and `tools/call` for the six canonical tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`).
- **Store** (`store.ts`): in-memory maps for repos, objects, refs, issues, labels, pull
  requests and comments. The bearer token does not encode a login, so the server learns
  the viewer login from the first owner a request names. State is deterministic:
  timestamps come from `MAKEFUN_TRIAL_NOW` (else the scenario epoch 2025-01-01) plus a
  monotonic 1s tick — no wall clock, no randomness — so a replay leaves the state
  export byte for byte.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Local validation

With the kit's runner, process driver:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree
```

Practice trials 0 and 1: **120/120 checks** (git 30, repos 15, issues 15, pulls 20,
graphql 20, mcp 15, protocol 5), agent 200/200, perf 141–148/200, total score
941–948; replay matched byte for byte.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server — routes the four surfaces onto one store.
- `git.ts`, `gitobj.ts`, `rest.ts`, `graphql.ts`, `mcp.ts`, `store.ts`, `util.ts`: the forge.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yfywnefc&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
