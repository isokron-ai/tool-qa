# Publishing results to mcp-results

How the loop's accepted results become the open dataset in
[isokron-ai/mcp-results](https://github.com/isokron-ai/mcp-results). The code is in
[`publish/`](../publish), the workflow is
[`publish-results.yml`](../.github/workflows/publish-results.yml), and the format a
consumer reads is in mcp-results' `docs/DATA.md`. **It is switched off.** Nothing is
published until the variable `RESULTS_PUBLISH_ENABLED` is `true` ("Before the switch is
flipped" below).

## What is published

One record per result that ingest accepted: which tool version measured which server in
which lane, when, with which run key and attempt, and the registry fields it observed.
Only fields the field registry marks `active` and class `P` or `P-s`. Coverage is stated
next to the measurements: assessed, or not assessed and whose limit it was (our tool, the
server, infrastructure, our policy). A skip of ours is published as our limit, never as a
failed server (`docs/MEASUREMENTS.md`, rules 3 and 4). Servers are named by company and
repository.

**Never published**, by construction and by test:

- A result that carries a field of class S (an actual security issue) or M (evidence of
  malicious behaviour). It is held whole and silently: no record, no count, no log line,
  no mention in the run summary or the pull request. A result's position in its attempt
  is not published either (the record id is `sha256(attempt_id, run_key)`), so a gap in
  positions shows nothing. Everything about what was held or left out, for any reason,
  stays out of every public place: the public report, the log, the run summary and the pull
  request say only how many records were added and how many were already there. The rest
  goes to a private report, age-sealed to the loop key and uploaded as an artifact
  (`publish-private-*`): a public count of accepted results elsewhere (ingest's logs) next
  to a public count of held ones would give the number held as security class.
- Fields of class P-h, B, P-t, PA and X, and fields that are `planned` or undeclared.
  P-h and B need a person to confirm a finding first, and no per-record confirmation
  exists yet. P-t is author text with no licence decision yet. PA is aggregates only.
  These are counted by class in the run report (not S or M), never named or valued.
- Anything under `results/`, `raw/`, `logs/` or `controls/` of a bundle: tool reports
  (they hold findings), captured server output and logs. Only `observations/` is read.
- Anything from `rejected/` or `quarantine/`. Only `accepted/<attempt>/<index>/` is read,
  and only if its own `ingest.json` says `accepted`, agrees with the manifest on attempt,
  item, run key and fence, and every observation file has the sha256 the manifest lists.
- Skip evidence paths, and any value that looks like a secret or an email.
- A result whose every field was left out and that has no skip: it would read as a clean
  assessment of nothing.

## Where it runs and where the key is

The key that opens sealed results (`AGE_IDENTITY`) is in the `loop` environment and on
the owner's Mac. The publisher therefore runs as a tool-qa workflow in that environment.
Three jobs: **build** (the key, no App secret), **verify** (no secret at all, no
environment) and **deliver** (the App, no key). The key goes to the build step only. The
publisher reads it into memory, drops it from its environment and scrubs it from logs; age
needs it as a file, so it touches disk as a 0600 file in a fresh 0700 directory for the
moment of each decryption and is removed straight after (`ingest/age.mjs`). No decrypted
result is written to disk: the only output is the redacted plain files in the job's temporary
folder. Two things are uploaded as artifacts, because the jobs must hand files on: the
redacted output (the files that would be in the pull request, nothing held; kept one day;
artifacts of a public repository can be downloaded by any signed-in GitHub user, which is
the same exposure as the pull request itself) and the sealed private report. The verify and
deliver jobs check the files against one digest the build job gives them.

```
 ingest-keep-<run>-<attempt> artifacts (sealed keep-*.tar.age, this repository, 90 days)
        |  actions: read, the job's own token; each artifact checked to come from pump.yml on main
        v
 build job (AGE_IDENTITY)    publish/run.mjs
        |  decrypt in memory -> accepted items only -> checks -> policy -> redaction -> records
        |  merge with what is already in mcp-results/data (a public read of main)
        |  -> publish-out (the changed files, SHA256SUMS), publish-private (sealed report)
        v
 verify job (no secret)      publish/pin-check.mjs, then mcp-results' scripts/verify.mjs
        |                    --base <the commit the build job read> (append-only)
        v
 deliver job (App, no key)   checks the digest, then publish/deliver.mjs
        v
 one pull request on mcp-results (branch results/refresh), commit made through the API so
 GitHub signs it. A person merges it. The publisher never writes to main.
```

Reading older results: the artifacts last 90 days. The keep-forever release holds the
same sealed files for good, and the Mac's archive holds them too; `publish/run.mjs
--source-dir <folder>` reads either (the archive layout, or a keep-forever
`keep-<YYYY-MM>-<id>.tar` part) on a machine that has the key, as a dry run, and the
owner can review and commit that output by hand. The workflow itself reads the last
`RESULTS_PUBLISH_LOOKBACK_DAYS` days (default 7). The branch `results/refresh` is ours to
replace, but not over someone's own push: if its head is not a commit this publisher made
(they carry the line `Published-by: tool-qa publish-results`), delivery stops.

## Cadence

The workflow runs once a day (04:41 UTC) when switched on, and by hand
(`workflow_dispatch`; `dry_run` defaults to true: build and verify, print the counts, open
nothing). Each run starts from the current main of mcp-results and recomputes the whole
difference, so the branch `results/refresh` is replaced each time and one pull request
collects everything not yet merged.

## File layout in mcp-results

```
data/manifest.json                        counts, coverage, a digest for every file below
data/results/<lane>/<YYYY-MM-DD>.jsonl    one record per line, lane and UTC day of finish
data/corrections.jsonl                    corrections, written by hand, never by the publisher
```

A record's id is `sha256("<attempt_id>\n<run_key>")`. Records are written in
a canonical form (sorted keys), in (finish time, id) order, so the same set of records is
always the same bytes. The manifest has no clock: the same data is the same manifest. Each
new manifest names the digest of the one it replaced, so a removed batch shows.

The manifest carries, per lane: records, servers, coverage by state, fault side, first
and last time measured. These are the coverage numbers of the design (DESIGN §4.7, whose
text is not in this repository; the states and the fault rule are
`resultFault()` in `worker-kit/contract.mjs`). They count published records, not the
servers tracked: the denominator needs the state store and is not part of this change.

## Redaction

Per field, from its registry entry:

- **R1** (text written by the server's author): the matching secret span is masked
  (`[REDACTED:<rule>]`) and the observation is marked `masked`. If the text also holds a
  canary or a personal detail (R3, R4), the whole result is held.
- Every other value, `why` and `stage`: any hit of any redaction rule (ingest's rules, the
  same code) holds the whole result. Strings over 4096 characters, values over 64 KiB and
  JSON nested over 64 levels hold it too. Nothing is cut to fit.
- Held for these reasons (not S or M) the result is counted in the report under its reason
  (`redaction_hit`, `oversize`, `too_deep`, `coverage_mismatch`, `empty_assessed`) in the
  private report only. The whole record is scanned (subject, skips, tool names, workflow
  fields), not only the observations; one bad item is held and the rest are published.

Our own failures end the run **red** (exit 4, the `not clean` job) after the output has been
delivered: an unreadable sealed file, a result held for a coverage mismatch, a re-read
record that differs from its published one. They are not left in a pull request.

The checker that runs on the output is code from the other repository, so it runs in the job
with no secret, and only after `publish/pin-check.mjs` has shown that its files are the
ones whose sha256 are in `publish/verify-pin.json`. A change to the checker in mcp-results
takes effect here only when that file is updated in a reviewed pull request.

The registry used is the one on mcp-results main at run time, not the pin ingest uses. A
class tightened there applies at once. And before anything is written, everything already
published is checked against it (`auditStore`): if a published field is no longer
publishable, the record ids or digests do not recompute, or a value looks like a secret,
the run stops with exit 3 and nothing is written until a person has corrected the data.
The same applies to a record that would have to change: a registry or redaction change makes
a result read again differ from what was published. Results still inside the re-read window
(the lookback plus two days) are skipped and counted in the private report; the run then
ends not clean. A differing record older than the window stops the run, because nothing
that old should be read again.

## The security hold

Class S and M are the registry's, per field. There is no per-finding classification of
results in the sealed data (findings live in `results/`, which is not published), and no
mechanism that releases a held result when a disclosure window ends. So today the rule is
the simple one: **no finding-level security data is published at all**, and a result with
an S or M field is not published. When a disclosure window ends, releasing it is a
decision and a change (a release list the publisher reads), not something that happens by
itself. Hardening findings and tool issues (class B) wait for the same kind of change: a
record of a person's confirmation per finding.

## Corrections and retractions

Records are never edited. A correction is a line in `data/corrections.jsonl`: `supersede`
(replaced by another record), `retract` (stays, consumers ignore it) or `purge` (removed
from the files: a secret, personal data, a rights claim, a security hold). The publisher
reads the file: it never brings back a retracted or purged record from an older sealed
file, and a published record whose content would change is a conflict that stops the run
(exit 3), not an overwrite. Today a person writes the correction line and opens the pull
request; the issue form in mcp-results feeds that. A new result for the same server and
lane is not a correction, it is a new record.

## How a consumer verifies a record

`node scripts/verify.mjs [--history]` in mcp-results: digests of every file against the manifest, the
schema, `record_id` and `content_sha256` recomputed, the registry (class, status, nothing
S/M), no secrets, coverage consistent with the skips, counts recomputed, corrections
consistent; `--history` also walks the chain of manifests through git and fails if any
commit changes or removes a record an earlier one published (append-only; only a purge
correction lets one go). The record names
the worker run (`provenance.workflow`), a public Actions run.

## Before the switch is flipped

1. Merge the mcp-results pull request (the data format and `verify.mjs`); the workflow
   runs that checker.
2. The App needs `contents: write` and `pull_requests: write`, and an installation that
   includes `mcp-results` (today: Actions, Issues, Metadata; `tool-qa` and the worker
   repositories). The same App and key, a wider grant: it is an owner action in the App
   and organisation settings. Until then the deliver step fails with a message saying so
   and creates nothing. If widening the App is not wanted, the dry-run output can be
   committed by hand.
3. Set `RESULTS_PUBLISH_ENABLED=true` (repository or `loop` environment). Run the
   workflow by hand with `dry_run` true and read the counts in the summary.
4. First pull request: review it by hand. Look at the fields under R3 (`repo_core`,
   `contributors_counts`, `owner_org_facts`: logins and organisation facts) and at author
   text under R1 before merging; the publisher cannot tell a name from a login.
5. After merging mcp-results#11, make sure `publish/verify-pin.json` matches the merged
   checker (`node publish/pin-check.mjs <checkout>`); the verify job fails otherwise. And
   after each merge of a data pull request, make a signed tag of the new manifest's digest:
   no step does that yet.
6. Decide, as the owner: whether to auto-merge later batches once `verify.mjs` passes;
   what to do with P-t text (a licence decision); a per-finding confirmation record for
   class B and P-h; a release list for class S.

## Stop it

`RESULTS_PUBLISH_ENABLED` unset or anything but `true`: the first step stops the job.
`LOOP_ENABLED`, `LOOP_PAUSE_UNTIL` and `LANE_PUBLISH_RESULTS_ENABLED` work as for every
loop job. Already merged data is removed by a correction, not by switching off.

## Tests

`node --test publish/`. Named regressions `R-PUB-01` to `R-PUB-10` (`REGRESSIONS.md`).
`node publish/sample.mjs --results <mcp-results checkout> --out <folder>` is a dry
run on synthetic input.
