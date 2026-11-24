# Regressions

Every problem found in the loop worker (`corpus/scan-static.mjs` and its workflow) is pinned by a named test
that stays in the suite for good. Tests are named after their row (`R-SS-01: ...`), and
[`test/regressions.test.mjs`](test/regressions.test.mjs) fails if a row names a test that does not exist, or if
a test named `R-SS-...` has no row.

New rows go at the end with the next free ID: the ID, what the problem was (severity first), the tests that pin
it (`file` › `test name`), and the commit(s) that fixed it.

| ID | What it was | Pinned by | Fix |
|---|---|---|---|
| R-SS-01 | HIGH. raw/ had no size cap: a constant shared by every tool turned about 70 KB of source into a 23 MB `raw/subject/tools.json`, over tool-qa's 8 MiB per file, and enough tools threw `RangeError: Invalid string length`. `buildBundle` and `writeItem` were outside the never-throw guard, so the run exited 3 and none of the 25 items got a bundle, on every re-dispatch. | `test/scan-static.test.mjs` › `R-SS-01: 5,000 tools sharing a constant: no RangeError, the raw file is cut, nothing over the caps`<br>`test/scan-static.test.mjs` › `R-SS-01: a bundle that cannot be built or written falls back to a minimal one, and the shard goes on`<br>`test/scan-static.test.mjs` › `R-SS-01: a constant shared by every tool gives a raw/ file cut to the cap, marked raw_truncated, and a bundle tool-qa accepts` | 0866426 |
| R-SS-10 | LOW (hardening). A subject's thread held the token and could ask for any host. | `test/scan-static.test.mjs` › `R-SS-10: the token stays in the parent, goes to api.github.com only, and a thread reaches no other host` | cd85233 |
