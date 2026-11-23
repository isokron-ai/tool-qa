# history/popularity (H3: download and star counts)

Snapshots popularity for the packages and repositories listed in `history/seed.txt`
(`ecosystem:name`, one per line; `npm`, `pypi`, `crates`, `github`; github names are `owner/repo`).
The seed ships empty, so a run with no seed makes no requests and writes empty files plus a manifest.

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
- The workflow does not yet pass the crates subset (it is an artifact of the `history-packages` run). With
  no crates in the seed that does nothing; with crates in the seed the run reports an error until a subset file is supplied.
- Shares `history/packages/lib/` for HTTP and manifests.
