# Regression ledger

One row per thing that went wrong, or could, in the sandbox: what it was, the tests that pin it,
and the commit that fixed it. Each test named here starts with its row's ID, and
`test/regressions.test.mjs` fails if a row names a test that does not exist, or if a test with an
ID is missing from this page.

- `R-SBX-*`: findings of the security review of the sandbox (pull request 5).
- `R-CASE-*`: the hostile self test cases (`selftest/hostile.py`). Each also runs for real, under
  gVisor, in the `sandbox-selftest` workflow and before every corpus shard.
- `R-CI-*`: root causes found getting the self test green on GitHub's runners.
- `R-MUT-*`: the proof that the self test can fail (one protection off at a time).

| ID | What it was | Pinned by | Fix |
|---|---|---|---|
| R-SBX-01 | A target could end its own telemetry with one bad record (`CONNECT a.b:99999` made a port the schema refused; the error dropped the install's DNS and sinkhole lines), and control bytes in traced paths could push a trace summary past 256 KiB. | `test/telemetry.test.mjs` `R-SBX-01 a container cannot stop the telemetry: its numbers are clamped, a refused record is counted and left out`<br>`test/telemetry.test.mjs` `R-SBX-01 a trace summary is cut to fit a record, least telling lists first, by its JSON size`<br>`test/check-selftest.test.mjs` `R-SBX-01 check-selftest: evidence the schema refused and left out fails the run` | 197c19f |
| R-SBX-04 | A target could forge trace lines (runsc prints paths unquoted) or hide real ones behind floods and caps, and nothing said when a log or rate limit was hit. | `test/trace.test.mjs` `R-SBX-04 a file name with a line break cannot pass for a trace line unnoticed`<br>`test/trace.test.mjs` `R-SBX-04 a flood of refused calls cannot push out the one that worked`<br>`test/selftest.test.mjs` `R-SBX-04 a trace a target may have shaped, or one cut short, cannot carry a verdict`<br>`test/sandbox-run.test.mjs` `R-SBX-04 limits that cut evidence short are reported: firewall rate limit, logger line limit, a trace cut to fit`<br>`test/check-selftest.test.mjs` `R-SBX-04 check-selftest: a case whose evidence a log or rate limit cut short fails` | 1411417, 6d10237, 0f0f83c |
| R-CASE-01 | direct-ip: a connection to an outside address by IP. | `test/selftest.test.mjs` `R-CASE-01 direct-ip: a connection to an outside address by IP is refused and traced` | 1b16014 |
| R-CI-01 | Every case failed at "work volume failed (exit 1)": the helper ran chown and then chmod, and root without CAP_FOWNER may not chmod what 65534 now owns. | `test/docker.test.mjs` `R-CI-01 the work volume is chmod-ed before it is chown-ed: root without CAP_FOWNER cannot chmod what it no longer owns` | 40770fc |
| R-MUT-00 | Nothing showed the self test could fail. Each protection is now turned off in turn (`--disable`, selftest-mutation lane only) in the `mutation` job, which passes only when the run fails for the reason that protection explains. | `test/mutation.test.mjs` `R-MUT-00 a mutated run counts only when it failed for the reason its protection explains`<br>`test/workflows.test.mjs` `R-MUT-00 sandbox-selftest: a mutation job turns off each protection in turn and must see the self test fail for that reason` | 3598cbb |
