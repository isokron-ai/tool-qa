# history/packages (H2: package feeds)

Records which MCP-related packages changed, by ecosystem, once a day. Output is NDJSON.gz plus a
`manifest-<source>.json` per source (sha256, row counts, start/finish times, errors). The workflow
`history-packages.yml` runs it at 04:07 UTC and attests the manifests.

Run locally: `node history/packages/run.mjs --out out --state .state [--source npm,pypi,crates,go]`.
Tests (no network): `node --test 'history/packages/test/*.test.mjs'`.

## What counts as MCP

`lib/matcher.mjs`. A package matches if its name contains `mcp` as a whole token (`mcp-server`,
`@acme/mcp`, `foo_mcp`; not `mcpx`), or a keyword is `mcp` or `modelcontextprotocol`, or its
description says "MCP" or "Model Context Protocol". Not every feed carries every field, see below.

## Sources

| Source | Endpoint | Position kept | Matching |
|---|---|---|---|
| npm | [`replicate.npmjs.com/_changes`](https://github.com/npm/registry/blob/main/docs/REPLICATE-API.md) | `since` sequence | name, then keywords/description from the packument |
| PyPI | XML-RPC [`changelog_since_serial`](https://docs.pypi.org/api/xml-rpc/) at `pypi.org/pypi` | serial | name only |
| crates.io | [daily DB dump](https://crates.io/data-access) `static.crates.io/db-dump.tar.gz` | dump ETag | name, keywords, description |
| Go | [`index.golang.org/index?since=`](https://index.golang.org/) (see the [module index docs](https://go.dev/ref/mod#module-proxy)) | timestamp | module path |

Use is subject to each registry's terms: [npm](https://docs.npmjs.com/policies/open-source-terms),
[PyPI](https://pypi.org/policy/terms-of-use/), [crates.io](https://crates.io/policies),
[Go module mirror](https://proxy.golang.org/privacy).

### npm
The feed returns only `{seq, id, changes}`. As checked in November 2026 it rejects `include_docs` and
`since=now` with HTTP 400. So we keep ids whose name matches, plus names already known to match by
keyword (a `known` list in state, refreshed each run from the registry search API
`/-/v1/search?text=keywords:mcp`, up to 4 pages of 250 per keyword), then fetch each candidate's
packument to apply the full matcher and list the versions published since the previous run (minus
one hour of overlap). Limit: a package that has no `mcp` in its name and was not returned by the
keyword search is not seen. First run starts at the current head of the feed, it does not replay history.
If a packument fetch fails the run stops there and `since` does not advance (changes may repeat next
run; none are skipped).

### PyPI
PyPI marks XML-RPC as frozen; there is no JSON changelog. `changelog_last_serial` gives the head;
`changelog_since_serial` gives events `[name, version, timestamp, action, serial]`. The reply is
parsed with a small built-in reader (no XML dependency). The changelog has no keywords, so matching is by name.
First run starts at the current serial.

### crates.io
The dump is about 2.3 GB. `crates.mjs` streams it once, hashes the whole archive, reads only
`crates.csv`, `keywords.csv`, `crates_keywords.csv`, `crate_downloads.csv`, `versions.csv` and
`metadata.json`, and discards the rest. Nothing is written to disk. A HEAD request first: if the ETag
matches the last run, the dump is skipped. Output rows have counts and dates, plus `description_len`;
the description text itself is not stored. Crates named in `history/seed.txt` are kept too, with match
reason `seed`, even when the matcher misses them, because H3 counts seeded crates from this subset. If a runner cannot spare the download time, run it weekly
instead: the logic is the same, only `--source` changes. The crates.io data-access page asks users to
use the dump instead of crawling the API, which is why no API calls are made.

### Go
The index is paged by timestamp (`limit=2000`). `since` is inclusive, so the last entry of one run
can appear again at the start of the next; consumers should dedupe on `path@version`.

## Rate limits and failure
Requests send a descriptive User-Agent. HTTP 429 and 5xx are retried up to 4 times, waiting for
`Retry-After` (capped at 2 minutes) or backing off 1, 2, 4, 8 seconds. A source that fails keeps its old
position and the run exits 1, after still writing the manifest for every source.

## State
Positions are JSON files in `--state`. The workflow keeps them in the Actions cache (new key per run,
newest restored). If the cache is evicted (unused for 7 days), npm, PyPI and Go start again from now and
leave a gap that the manifest's `since_before` / `since_after` fields make visible.

Each manifest records `state_restored` (was a saved position found?) and `gap_possible` (true when it
was not, for npm, PyPI and Go). In that case the runner also prints a `::warning` annotation, because
the first run after an eviction cannot tell a fresh start from a lost cache.
