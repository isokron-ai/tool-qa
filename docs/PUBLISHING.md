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

## Where it runs, where the keys are, and what is public when

Both repositories are public. A readable artifact here, or a branch or pull request on
mcp-results, is public the moment it exists, and a commit and its blobs stay reachable even
if the pull request is closed. So **nothing readable leaves the build job, and nothing is
pushed to mcp-results, before a person has read it.**

| Job | When | Environment | Secrets | Does |
|---|---|---|---|---|
| `build` | the schedule (04:41 UTC) and a manual dispatch with no inputs | `loop` | `AGE_IDENTITY`, in the build step only | Reads and decrypts in memory, builds the files, runs the pinned checker (no secret in that step or after it), seals the output to `worker-kit/ingest.pub`, uploads **ciphertext only**: the sealed output (14 days) and the sealed, padded private report (30 days). Never delivers. |
| `not clean` | after `build`, only if it was not clean | none | none | Ends the run red. |
| `deliver` | only a manual dispatch with a build run id and the reviewed digest | `publish` (required reviewers) | `AGE_IDENTITY` in the open step only, the App (`APP_ID`, `APP_INSTALLATION_ID`, `APP_PRIVATE_KEY`) in the deliver step only | Waits for approval; checks the review gate is set up; opens that run's sealed output only if its `SHA256SUMS` has exactly the digest given; opens the pull request. |

The key reads into memory and is dropped from the environment and scrubbed from logs. age
needs it as a file, so it touches disk as a 0600 file in a fresh 0700 directory for the moment
of each decryption and is removed straight after (`ingest/age.mjs`). No decrypted result is
written to disk: the output folder holds only the redacted plain files.

```
 ingest-keep-<run>-<attempt> artifacts (sealed keep-*.tar.age, this repository, 90 days)
        |  actions: read, the job's own token; each artifact checked to come from pump.yml on main
        v
 build job (AGE_IDENTITY)    publish/run.mjs: decrypt in memory -> accepted items only -> checks ->
        |                    policy -> redaction -> records; merge with mcp-results main (public read)
        |                    publish/pin-check.mjs, then mcp-results' scripts/verify.mjs --base <commit>
        |                    publish/seal.mjs seal: tar + age to ingest.pub, BASE_SHA, SHA256SUMS
        v
 sealed artifact publish-out-<run>-<attempt>   (ciphertext)       sealed publish-private-... (ciphertext)
        |
        |   REVIEW, on the owner's machine (below), then a manual dispatch with run id + digest
        v
 deliver job (environment publish: approval first)
        |  publish/seal.mjs open --expect <reviewed digest>   (AGE_IDENTITY, this step only)
        |  publish/deliver.mjs                                (the App, this step only)
        v
 one pull request on mcp-results (branch results/refresh), commit made through the API so
 GitHub signs it. A person merges it. The publisher never writes to main.
```

### Review (before any delivery)

1. Open the build run's summary: it shows the digest of the output's `SHA256SUMS` and the
   public report (records added, files).
2. Download the artifact `publish-out-<run>-<attempt>` (GitHub gives a zip holding
   `publish-out.tar.age`) and open it with the Mac's copy of the loop key:
   `age -d -i ~/.isokron/loop-age-identity.key publish-out.tar.age | tar -x -C out`.
3. `shasum -a 256 out/SHA256SUMS` must give the digest in the summary. Copy `out/data/` over a
   checkout of mcp-results at the commit in `out/BASE_SHA` and run `node scripts/verify.mjs
   --base <that commit>`. Read the records in `out/data/results/` (the R3 fields and author
   text under R1 especially) and `out/report.json`.
4. If it is right: dispatch `publish-results` with `deliver_run_id` (the build run id) and
   `reviewed_sums` (the digest). The `deliver` job then waits for a required reviewer on the
   `publish` environment, and delivers only a sealed output with exactly that digest. A
   changed output has another digest, so an approval does not carry over to it.
5. Optionally open the sealed private report the same way (`report.json.age`, fixed 16 KiB
   before encryption): what was held and why, and our own failures.

### The `publish` environment (owner)

GitHub creates an environment that a workflow names when it does not exist, with no
protection. So a missing environment does not stop a run; the workflow fails closed another
way. The owner creates `publish` with himself as a required reviewer, puts `AGE_IDENTITY`,
`APP_PRIVATE_KEY`, `APP_ID` and `APP_INSTALLATION_ID` there (and removes the App secrets from
`loop`, which only needs the key), and only then sets the variable `PUBLISH_REVIEW_GATE` to
`required-reviewers` in that environment. The deliver job's first step stops unless that
variable has that value, and the secrets it needs are not available without the
environment. `RESULTS_PUBLISH_ENABLED`, `LOOP_ENABLED`, `LOOP_PAUSE_UNTIL` and the lane switch
are repository variables (the deliver job, in `publish`, reads them too).

### What stays visible, and is accepted

Ingest's public pump logs show how many results were accepted each day, and the public
report shows how many records were added, so how many were held can be estimated per day by
subtraction. That number is accepted; no identity, subject or finding comes with it. The
`not clean` red run and its message say that a coverage mismatch, an unreadable sealed file
or a skipped conflict happened. None of those is security class, so that is fine. The fence is
not published: one counter is shared by every result, and its gaps would show where results
were held. The position in the attempt is not published either, and the sealed private report
has a fixed size.

## Cadence

The `build` job runs once a day (04:41 UTC) when switched on, and by hand
(`workflow_dispatch` with no inputs). Neither delivers: delivery is a separate manual dispatch
with the reviewed digest ("Review"). Each run starts from the current main of mcp-results and recomputes the whole
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

1. Merge the mcp-results pull request (the data format and `verify.mjs`), then make sure
   `publish/verify-pin.json` matches the merged checker (`node publish/pin-check.mjs
   <checkout>`); the build fails otherwise.
2. Create the `publish` environment with required reviewers and move the App and key
   secrets there ("The `publish` environment"); the App needs `contents: write` and
   `pull_requests: write` and an installation that includes `mcp-results` (today: Actions,
   Issues, Metadata). Same App and key, a wider grant. Until then delivery fails with a
   message saying so and creates nothing; building and sealing work without any of it.
3. Set `RESULTS_PUBLISH_ENABLED=true` (repository variable). The first scheduled or manual
   build only produces sealed artifacts. Review one ("Review"), then dispatch a delivery.
4. Look at the R3 fields (`repo_core`, `contributors_counts`, `owner_org_facts`) and author
   text under R1 in the first batch; the publisher cannot tell a name from a login.
5. After each merge of a data pull request, make a signed tag of the new manifest's digest:
   no step does that yet.
6. Decide, as the owner: what to do with P-t text (a licence decision); a per-finding
   confirmation record for class B and P-h; a release list for class S; whether later
   batches may skip the manual digest.

## Stop it

`RESULTS_PUBLISH_ENABLED` unset or anything but `true`: the first step stops the job.
`LOOP_ENABLED`, `LOOP_PAUSE_UNTIL` and `LANE_PUBLISH_RESULTS_ENABLED` work as for every
loop job. Already merged data is removed by a correction, not by switching off.

## Tests

`node --test publish/`. Named regressions `R-PUB-01` to `R-PUB-10` (`REGRESSIONS.md`).
`node publish/sample.mjs --results <mcp-results checkout> --out <folder>` is a dry
run on synthetic input.
