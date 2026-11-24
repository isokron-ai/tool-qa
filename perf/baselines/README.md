# Baselines

One file per server and release, `<server>/<version>.json` (schema `tool-qa/perf/1`), taken from the
`perf-baselines` workflow on GitHub-hosted runners. A release is compared only with the newest earlier
release of the same server. How they are made and judged: [docs/PERFORMANCE.md](../../docs/PERFORMANCE.md).

To add one: run the workflow, download the artifact `perf-<server>-<version>`, and commit its JSON here
under that name. Do not commit a laptop run.
