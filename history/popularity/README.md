# history/popularity (H3: download and star counts)

Snapshots popularity for the packages and repositories listed in `history/seed.txt`
(`ecosystem:name`, one per line; `npm`, `pypi`, `crates`, `github`; github names are `owner/repo`).
The seed holds the v1 stratified list (see `history/seed/README.md`). An empty seed makes no requests and writes empty files plus a manifest.

Run locally: `node history/popularity/run.mjs --out out --state .state --mode downloads|stars|all`.
Tests (no network): `node --test 'history/popularity/test/*.test.mjs'`.

## Cadence
`history-popularity.yml`: Mondays 05:11 UTC runs `all` (downloads and stars); the other days at
05:11 UTC run `stars` only. Manual runs can choose the mode. Manifests are attested; artifacts keep 30 days.

## Sources
| Data | Endpoint | Docs |
|---|---|---|
| npm point count, last 7 days | `api.npmjs.org/downloads/point/last-week/<pkg>` | [npm download counts API](https://github.com/npm/registry/blob/main/docs/download-counts.md) |
| npm per-version, last 7 days | `api.npmjs.org/versions/<pkg>/last-week` | same page. The per-version view only covers a recent window, so it has to be captured weekly |
| PyPI recent downloads | `pypistats.org/api/packages/<pkg>/recent` | [PyPI Stats API](https://pypistats.org/api/) |
| crates.io downloads | the H2 dump subset (`crates-*.ndjson.gz`) via `--crates-subset` | [crates.io data access](https://crates.io/data-access) |
| GitHub stars, forks, latest release | `api.github.com/repos/{owner}/{repo}` and `/releases/latest` | [REST API](https://docs.github.com/en/rest), [conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate) |

## Rate limits
- GitHub: `GITHUB_TOKEN` from the environment. Each repo stores its ETags and last values in
  `github-etags.json`; requests send `If-None-Match`, and a 304 reply is free against the rate limit and
  reuses the stored values. The run stops early on HTTP 403/429 or when fewer than 20 requests remain,
  and says how many repos were skipped (`github.skipped_rate_limit` in the manifest).
- npm: sequential, 150 ms between packages. pypistats: sequential, 1 s between packages.
- 429/5xx are retried with back-off (see `history/packages/README.md`).
- Per-package errors are recorded in the manifest; the other packages still run.

## Notes
- Rows have `observed_at`; npm rows also have the window start and end the API reported.
- On `all` and `downloads` runs the workflow downloads the newest `crates-*.ndjson.gz` from the last 10 successful
  `history-packages` runs and passes it as `--crates-subset`. H2 keeps every seeded crate in that subset (match reason
  `seed`). If no subset is found, the run warns and skips crates.
- A run fails (`ok: false`, exit 1) only when it is broken: a network or server error that survives the retries, or
  a GitHub stop before any repo was read. A package or repo that is gone (404, or a crate absent from the subset) goes in
  the manifest's `missing` list. A stop at the GitHub rate limit goes in `warnings`, with `github.skipped_rate_limit`.
  The first runs on a large seed stop at GITHUB_TOKEN's 1,000 requests per hour. The ETag cache fills over a few days
  and 304 answers are free, so later runs cover the whole seed. Each run writes these counts to the job summary.
- Shares `history/packages/lib/` for HTTP and manifests.
