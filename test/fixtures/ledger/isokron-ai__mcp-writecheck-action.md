# Regression ledger

One row per thing that went wrong, or could, in this repository's loop worker (`loop/`, `corpus.yml`,
`loop-fixture.yml`): what it was, the test that pins it, and the commit that fixed it. Each test named here starts
with its row's ID.

- `R-WC-*`: the writecheck loop worker (pull request 61).

| ID | What went wrong | Test | Fix |
|---|---|---|---|
| R-WC-01 | The tools volume held mcp-surface-corpus's `sandbox/` only; its network logger imports `../src/dns.mjs`, so the logger did not start and every unit (the controls first) failed on the first fixture run. The volume now holds `sandbox/` and `src/`, and the driver refuses to pack a volume whose code imports a file that is not in it. | `test/loop.test.mjs`: "R-WC-01: the tools volume carries what its code imports" | this commit |
| R-WC-02 | The driver called `settingsManifest` from mcp-surface-corpus without loading `src/sandbox-env.mjs`, where it lives: the first sandbox step threw. The driver now loads that module and checks, at load, that every name it uses is exported; a test keeps that list equal to the names the source uses (and checks the exports against a checkout when `MSC_DIR` is set). | `test/loop.test.mjs`: "R-WC-02: every name the driver takes from mcp-surface-corpus is in the list it checks at load" | this commit |
