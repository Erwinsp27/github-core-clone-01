# Forge — a standalone GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Erwinsp27/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Erwinsp27/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, zero-dependency GitHub-compatible forge for the
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty:
git smart HTTP, REST v3, GraphQL v4 and MCP, all backed by one in-memory store,
so a repository created over any surface reads back identically over the others.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing to
install: the program imports Node built-ins and its own modules only, and the
trial has no package manager and no internet.

`MAKEFUN_ENV_URL` must name the env's origin (the harness sets it). Without it
the program exits 1. `MAKEFUN_SHOP_TOKEN` is the bearer token every API call
must present; when it is unset (local development only) any non-empty bearer
token is accepted. `MAKEFUN_TRIAL_NOW` fixes the timestamps the forge stamps
on commits, issues and merges (RFC 3339 or epoch milliseconds); without it the
forge uses `2025-01-01T00:00:00Z`, so a replay answers byte-identical data.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | The entry ↔ env lifecycle (starter, unchanged): bind an ephemeral port, `POST /register`, poll `GET /done`, exit 0. |
| `app.ts` | The HTTP server and router: `/healthz`, `/api/graphql`, `/mcp`, `/api/v3/*`, then `/{owner}/{repo}.git/*`. |
| `src/util.ts` | JSON answers, body reading, bearer auth, deterministic request ids. |
| `src/gitcore.ts` | The git object model: SHA-1 ids, pkt-line framing, packfile read/write (OFS/REF deltas, thin-pack bases), commit/tree/tag parse and build. |
| `src/store.ts` | The in-memory store (repositories, issues, pull requests) and the graph algorithms: ancestry, merge-base, fetch planning (haves, shallow/deepen), three-way merge conflicts, squash merges. |
| `src/git-http.ts` | Git smart HTTP: protocol v0 and v2 advertisements, `ls-refs`, fetch (v0 + v2, shallow/deepen, incremental), receive-pack with fast-forward rules and report-status. |
| `src/rest.ts` | GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, files, merges. |
| `src/graphql.ts` | GitHub GraphQL v4: a small parser for the documents `gh` sends, plus an executor over the same store (viewer, repository, issues with ordering and cursor pagination, mutations, `node(id:)`, introspection, batched operations). |
| `src/mcp.ts` | Model Context Protocol over streamable HTTP: `server/discover` (2026-07-28) plus the legacy `initialize` handshake, `tools/list` and `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`. |

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org` |
| `GET /api/v3/meta` | 200 `{"installed_version": "1.0.0"}` |
| `GET /api/v3/user` | The token owner's login |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GraphQL v4 |
| `POST /mcp` | MCP (modern `server/discover` era, legacy `initialize` also answered) |
| `/<owner>/<repo>.git/...` | Git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Every REST reply is `application/json` and carries a non-empty
`X-GitHub-Request-Id`. A request without the bearer token is 401; a repository
under another owner is 404, never 403.

## Design notes

- **One store, four surfaces.** A repository, issue or pull request created over
  MCP reads back over REST and GraphQL with the same ids: REST ids are numbers,
  GraphQL ids are opaque base64url global ids that never equal the numeric id.
- **Real git objects.** Blobs, trees, commits and annotated tags are stored by
  their SHA-1; packs are written plain (version 2, valid trailer) and read back
  with delta resolution, including thin-pack bases held by the store. Pushes are
  fast-forward-checked (`non-fast-forward` on refusal) and answered with
  sideband-framed report-status.
- **Deterministic.** No wall clock and no unseeded randomness in any request
  path: timestamps come from `MAKEFUN_TRIAL_NOW`, request ids are a counter,
  global ids derive from the object's coordinates. A replay of the same requests
  produces the same state.
- **Fast.** In-memory maps, no disk, no logging on the hot path; the four
  benchmark workloads (push, clone, read, write) are served from the same code
  the conformance checks exercise.

---

<sub>Entered on [make.fun](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
