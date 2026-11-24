# Contributing

Thanks for your interest. This repository runs IsoKron's own testing loop, so
most changes come from the IsoKron team, but issues and small pull requests are
welcome.

- **Bugs and ideas:** open an issue. For security problems, follow
  [SECURITY.md](SECURITY.md) instead.
- **Pull requests:** keep them small and focused. Add or update tests with
  `node:test`, and run `npm test` before you push.
- **Regressions:** every problem found (a review finding, a bug report, an
  incident) gets a permanent test named after its row in
  [REGRESSIONS.md](REGRESSIONS.md) (`R-ING-17: ...`), and a row there: what it
  was, the tests that pin it, the fix commit. `test/regressions.test.mjs`
  fails if the two drift apart.
- **Workflows:** every workflow must pass `npm run check-workflows`, actionlint
  and zizmor. That means top-level `permissions: {}`, explicit permissions and
  `timeout-minutes` on every job, actions pinned to a full commit SHA with the
  tag in a comment, no `pull_request_target`, and event data passed to `run:`
  through `env`, never inline.
- **Dependencies:** there are no runtime dependencies. Please don't add one
  without opening an issue first.
- **No secrets** in code, tests or fixtures. Tests use synthetic data and make
  no network calls.

By contributing you agree that your work is released under the
[MIT License](LICENSE).
