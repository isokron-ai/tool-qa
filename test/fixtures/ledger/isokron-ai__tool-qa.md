# Regressions

Every problem found in tool-qa is pinned by a named test that stays in the
suite for good. Tests are named after their row (`R-ING-07: ...`), and
[`test/regressions.test.mjs`](test/regressions.test.mjs) fails if a row names
a test that does not exist, or if a test named `R-ING-...` has no row.

New rows go at the end with the next free ID. Each row: the ID, what the
problem was (severity first), the tests that pin it (`file` › `test name`),
and the commit(s) that fixed it.

| ID | What it was | Pinned by | Fix |
|---|---|---|---|
| R-ING-01 | HIGH. The email and JWT redaction patterns backtracked from every position of a long run: scanning was quadratic (80 KB of `a.` took 3.2 s, 1 MB about 8 minutes). One crafted bundle held the pump past its job timeout. | `ingest/test/redact.test.mjs` › `R-ING-01: every redaction rule scans 1 MiB of crafted text in linear time`<br>`ingest/test/redact.test.mjs` › `R-ING-01: the bounded patterns still find what they found before` | 70d658a |
| R-ING-06 | HIGH. Ingest ran before the reap, and open dispatches were awaited whatever their expiry, so an item that could not be judged was first in line on every later tick. | `ingest/test/collect.test.mjs` › `R-ING-06: a poison item is decided in its own tick and the items after it are still judged`<br>`pump/test/run.test.mjs` › `R-ING-06: expired dispatches are reaped before ingest looks at them` | 20a0fa4, 5426adf |
| R-ING-14 | LOW. `readZip` had no cap on entries or on the inflated total. | `test/unzip.test.mjs` › `R-ING-14: the default caps are in place`<br>`test/unzip.test.mjs` › `R-ING-14: too many entries, or too many bytes once inflated, are refused before inflating` | 99f6817 |
| R-ING-19 | LOW. `resolveRef` reads the worker branch with an actions-only token, which works only because worker repositories are public; a private one would have failed with no hint. Kept, documented, and made to fail closed with what to do. | `pump/test/dispatch.test.mjs` › `R-ING-19: the branch is read with the actions-only dispatch token; a private worker repo fails closed with what to do` | 9b6f971 |
| R-ING-20 | LOW. A row that says how it was found. Found by: CI. The rest of the text. | `test/a.test.mjs` › `R-ING-20: it's quoted` | abc1234 |
