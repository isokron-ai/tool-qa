# history/seed

How `history/seed.txt` and `history/seed-v1.json` were made. Seed v1 is the first stratified set of
open-source MCP servers whose popularity (H3) and daily tool lists (H4) we track.

## Rebuild
```
python3 -I history/seed/build_seed.py --registry <mcp-registry-snapshot-2026-11-21.jsonl.gz> --offline
```
Standard library only. `--offline` reads GitHub answers from `github-cache.json` (one `repos/{owner}/{repo}`
answer per candidate, taken 2026-11-23). Without it, missing repos are fetched with `gh api`.

## Method
1. **Frame.** Latest version of each server name in the official registry snapshot of 2026-11-21. Servers with
   no packages are dropped (remote-only servers are counted, never included). Servers with packages but no
   GitHub repository are counted and left out, because a subject is a GitHub repository. Entries are collapsed
   to the repository, so a repository with many registry entries counts once; up to 3 of its packages are kept.
2. **Always in.** Our five repositories and four npm packages (calibration), 14 Go and Rust servers we test
   (calibration), and the official reference servers `modelcontextprotocol/servers` with their published npm and
   PyPI packages (calibration).
3. **Random pool.** Repositories are grouped by package type (cargo, oci, mcpb, nuget, pypi, npm; the first match
   in that order). Fixed draws per group, with seed 20261123: all cargo, then oci, mcpb, nuget, pypi and npm
   in smaller numbers, so Go and Rust (mostly oci, mcpb and cargo) are not drowned out. Each draw's weight is
   1 / its inclusion probability.
4. **Strata.** Language and stars come from one GitHub call per pool member (about 1,190 calls). Language is
   mapped to Go, Rust, TS/JS, Python, C#, Java/Kotlin or Other. Transport comes from the registry package
   entries: stdio, http (streamable HTTP or SSE) or both. Star buckets: 0-9, 10-99, 100-999, 1000+.
5. **Final pick (997 subjects; the target was 1,000, and the usable pool ran out).** The weighted pool estimates each language's share of the frame. Go and Rust
   each get about twice their estimated share, chosen over transport x star bucket. The rest is chosen over
   language x transport x star bucket. Within a level, picks are split in proportion to the square root of each
   stratum's size, so small strata are not empty.
   Stars are only known after the call, so the pool could not be drawn by star bucket. The star-bucket
   split is therefore limited by the pool: every pool member with 10 or more stars is in the list, and the
   0-9 bucket (about 80% of the frame) makes up the rest. 58 pool members were gone from GitHub (404) and
   were dropped, and 8 more resolved to a repository already in the list (renames).
6. **Population.** `calibration` for our servers, the reference servers and the 14; `history` for the sample.

## Not in this version
Registry data cannot give SDK, registration idiom, size class, release cadence or tool count. Later phases add
those fields to `seed-v1.json` once the readers and daily probes have run.

## Files
- `history/seed.txt`: the list the popularity run reads (`github:owner/repo` plus `npm:`, `pypi:`, `crates:` lines).
- `history/seed-v1.json`: every subject with strata, population, star bucket and the sampling seed.
- `history/seed/github-cache.json`: the cached GitHub answers used to build it.

Built by IsoKron (https://isokron.ai).
