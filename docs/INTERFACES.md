# Interfaces

The contracts between the pump, worker workflows and ingest. Code that sits on
either side of one of these should change only together with this page.

## One writer

The state database (`state.sqlite` on the `state` release) has one writer: the
pump, inside the `pump` concurrency group. Ingest runs inside the pump for that
reason (below). The watchdog downloads a copy to read and never pushes. Only
while the pump is paused (`LANE_PUMP_ENABLED=false`) may anything else push
it: the manual re-ingest workflow (`.github/workflows/ingest.yml`, which
refuses to run while the pump lane is on and waits in the `pump` group), or a
person by hand (docs/OPERATIONS.md).

## Subjects

The due list reads `db.listSubjects()` and skips retired subjects
(`retired_at` set), subjects whose repository cannot be found (`gone_at` set)
and subjects merged into another (`alias_of` set). The pump fills the table
from the seed at start-up (`syncSeedSubjects(db, { now, file })` in
`pump/subjects.mjs`; docs/OPERATIONS.md, "Subjects: where they come from").
kv `subjects.seed` holds `{ file, source, sha256, mapping, subjects, tiers,
retired, loaded_at }` for the last load.

**Subject key, identity and name (state schema v8, loop upgrade #15).**

- `subjects.id` is the subject key: the owner/name the subject had when it
  was first seen, frozen. run_keys (`subject_id` field), leases, dispatch
  items, attempts and results name it, so it never changes.
- `subjects.repo_id` is the identity: GitHub's numeric repository id, with
  `node_id` and `repo_created_at`. At most one subject per id (a unique
  index). NULL until the pump looks it up (`pump/identity.mjs`,
  `refreshIdentities`); a subject not looked up yet works exactly as before.
- `subjects.name` is the repository's current owner/name, what the worker
  receives as `subject` (the item's `subject_name`). It follows renames and
  transfers; for subjects from before v8 it starts as the key.
- `id_status` (`ok`, `error`, `not_found`, `duplicate`, `conflict`, or NULL
  before the first lookup), `id_checked_at`, `gone_at` and `alias_of` say how
  the last lookup went. Every change is a row in `subject_events`
  (`id_bound`, `renamed`, `transferred`, `merged`, `not_found`,
  `found_again`, `id_conflict`), read with `db.listSubjectEvents(subject?)`.
- `db.applyIdentityLookup(key, {status, node, via}, { now })` applies one
  lookup (see its comment in `state/db.mjs` for the guards: the merge keeps
  the subject with history and moves the binding to it, a repository created
  after the subject was first seen is refused), and
  `db.identityCandidates({ now, retryMs, limit })` lists who to look up.

- `db.setSubjectVersion({ id, kind, source, tier, sha, artifactDigest, name, now })`
  inserts or updates a subject and clears `retired_at`. A new sha or digest
  moves `changed_at`; pass the current ones to keep them. `name` is used only
  when the subject is new (default: the key).
- `db.retireSubjects({ sourcePrefix, keep, now })` retires every active
  subject whose `source` starts with `sourcePrefix` and whose id is not in
  `keep`. Returns the number retired.
- A subject with no sha and no digest is refreshed on its tier's cadence:
  `maxAgeDays(cell, subject, tiers, tierName)` in `pump/due.mjs` falls back to
  `unversioned_max_age_days` in `pump/tiers.json` where the cell has no max age.

## Worker dispatch

The pump starts a worker with a `workflow_dispatch` on the workflow named in
`pump/workflows.json` (`repo`, `file`, `ref`). Every worker workflow takes these
inputs, all strings:

| Input | Meaning |
|---|---|
| `shard_id` | The shard's id, such as `scan-static-3f2a9c01b7d4`. Unique per dispatch. |
| `attempt_id` | The dispatch's id in the state store. Results must quote it. |
| `tool_sha` | Only on a lane whose `pin_check` is `enforce` and whose `versions.tool` pins a commit of the worker repository itself (the entry named after the repository): that commit in full, 40 hex. The worker runs that commit of its own code, not the branch head (R-PIN-01, below). Never sent otherwise, so a worker that does not declare it is not refused by GitHub. |
| `items` | JSON array, one entry per piece of work: `[{"subject": "...", "run_key": "<64 hex>", "fence": 17}, ...]`. `subject` is the repository's current owner/name (for a GitHub subject); the result is recorded under the subject key by `run_key`, so a rename before ingest changes nothing. At most 60,000 characters. |

A worker workflow must:

- set `run-name: shard ${{ inputs.shard_id }}`. When GitHub does not return the
  new run's id in the dispatch response, the pump finds the run by that name;
- have `workflow_dispatch` as its only trigger, `permissions: {}` and no
  secrets, like every worker;
- pass the inputs to its steps through `env:`, never by writing
  `${{ inputs.* }}` inside `run:`;
- report one result per item, each in its own bundle, quoting `run_key`,
  `attempt_id` and `fence` exactly as given. A result for anything else is
  rejected;
- run the server under test without the runner's environment (the sandbox
  does this), and never run untrusted code in a job, or a step, that holds
  `ACTIONS_RUNTIME_TOKEN`: with that token a server could upload a forged
  result for a sibling item of the same run, under its real name and
  identity. See "Running untrusted servers" in
  [`worker-kit/README.md`](../worker-kit/README.md).

Before sending, the pump records with the dispatch the commit `ref` points to
(read from the branch, `GET /repos/{repo}/branches/{ref}`, which needs no
permission on a public repository). Ingest rejects a run at any other commit
(`run_sha_mismatch`), including a run found by its name: a run name is only
a claim, so its own `head_sha` is never what it is checked against. If the
ref moves between that read and GitHub starting the run, the run is
rejected and the work is due again.

**Version pins (R-PIN-01).** A lane's `versions.tool` and `versions.probe`
go into every run_key, so they are the label each result is filed under, and
ingest makes the label true or refuses the result. Each pinned component must
be reported in the manifest's `tools` (worker-kit/README.md, "Reporting what
ran"); one reported at another version is refused as `pin_mismatch` on every
lane, except the lane's own commit pin (the `versions.tool` entry named after
the worker repository) on a `label` lane, which is listed as unverified with
a `self_pin_moved` note and accepted (R-PIN-02). Pins recorded for the
run_key that cannot be read are refused as `pin_unverified` on `enforce`
(`getAttempt` gives `pins: 'malformed'`). On a lane whose `pin_check` is `enforce` a component not proven (a
commit pin needs the full commit; any other pin the same string) is refused
as `pin_unverified`; on a `label` lane it is accepted and listed as unverified
in the item's report. A lane without `pin_check` is held to `enforce`.
Ingest takes each lane's mode from the config the pump dispatched with.
Before sending on an `enforce` lane, the pump resolves the lane's own commit
pin (`GET /repos/{repo}/commits/{sha}`, readable with the dispatch token on a
public repository) and sends it as `tool_sha`; a pin it cannot resolve is not
dispatched. Pin refusals are the tool side's fault, are not counted towards
parking, and pause the lane for an hour (`pump.paused:<workflow>` below).
OPERATIONS.md, "Version pins", has the rollout.

Dispatch inputs show up in the worker repositories' public run pages and
logs, so they carry only the shard and attempt ids, subject ids and opaque
`run_key`s and fences: never canaries, tokens or anything private.

The result format (files, artifact name, encryption, checks) is the worker
contract in [`worker-kit/README.md`](../worker-kit/README.md) and
[`ingest/README.md`](../ingest/README.md): one artifact per item,
`result-<attempt_id>-<index>.tar.age`, sealed to `worker-kit/ingest.pub`,
where `<index>` is the item's 0-based position in `items`. Result manifest v1
names exactly one `run_key`, which is why each item has its own bundle. Each
item is judged and recorded on its own: a missing or bad bundle rejects that
item only. For a dispatch of one item, ingest also accepts the older name
`result-<attempt_id>.tar.age`. Any `shard_size` in `pump/workflows.json`
works; `items` holds between one and `shard_size` entries.

How long a dispatch may take: 1.5 × (`setup_minutes` + items ×
`minutes_per_subject`) + 10 minutes, from `pump/workflows.json`. After that its
leases and its slot expire, the pump closes it as `lease_expired`, and the work
is due again. A result whose run completed later (by the run's `updated_at`
from GitHub) is stored as rejected. A run that completed inside the lease is on
time even when the pump only judges it after the lease ran out: `recordResult`
checks the lease against the run's completion (`completedAt`, R-CHAOS-02), and
until ingest has looked at such an expired dispatch the pump does not send its
work again (`holdRunKeys` in `runTick`).

## Writecheck modes: the write-backend contract (proposed, 27 Nov 2026)

Status: **proposed**. Nothing here is dispatched yet. The pump sends none of the inputs below until the
writecheck worker (isokron-ai/mcp-writecheck-action `corpus.yml`) declares them and a mode switch is turned on;
with both switches off (the default) writecheck is dispatched exactly as above. The full-mode work in
mcp-writecheck-action and the min-mode work in mcp-write-safety build against this section; a change to it
changes all three together.

### Where the facts come from: `write_backend` (lane `meta-backend`)

A trusted, static lane in this repository (`meta/backend.mjs`, workflow `meta-backend.yml`, like meta-github,
meta-registry and release-diff: nothing from a subject is installed, built or run). It reads the subject's
source archive from codeload.github.com as data (package manifests, compose files, `.env.example` and its
siblings, `server.json`, READMEs, OpenAPI files, code text) and emits one observation per subject,
`write_backend` (mcp-results `fields/registry.yaml`, class P-s, planned until seen; R-RES-18):

| Key | What |
|---|---|
| `class` | `local_full` (the backend runs inside a GitHub Actions job: the engine itself, or a stand-in listed as faithful and cleared in `meta/data/stand-ins.json`), `mock_min` (a hosted API with a published machine-readable description in `meta/data/spec-urls.json`, or an OpenAPI file in the repository), or `none` |
| `mode` | `full`, `min` or `none`: the writecheck mode the class maps to (`local_full` -> `full`, `mock_min` -> `min`) |
| `reason` | for `none` only: `no_backend_signal`, `hosted_without_spec`, `stand_in_not_cleared`, `no_stand_in`, `not_a_store`, `no_write_tools_seen` (the state adds `not_found` for a repository that is gone); otherwise null |
| `backend` | the primary backend: `{ id, kind }`, `id` a key of one of the two maps (`postgres`, `redis`, `github`, `slack` ...) or `repo-openapi` (the repository's own description file, at a full commit), `kind` one of `sql`, `kv`, `document`, `search`, `graph`, `vector`, `queue`, `object_store`, `mail`, `filesystem`, `git`, `cluster`, `service`, `hosted_api`, `browser` |
| `backends` | every backend seen: `{ id, kind, score, signals, role }`, role `primary`, `secondary` or `candidate` |
| `stand_in` | for `local_full`: `{ id, product, fidelity }` from the stand-in map (fidelity `real` or `faithful`); else null |
| `spec_url`, `spec_format` | for `mock_min`: the description's https URL and its format (`openapi3`, `swagger2`, `google_discovery`, `smithy`, `graphql_sdl`, `graphql_introspection`); else null |
| `env_names`, `base_url_env` | environment variable **names** the server reads (never values), sorted, at most 40; `base_url_env` the subset that points it at a host (`*_URL`, `*_URI`, `*_HOST`, `*_ENDPOINT`, `*_BASE_URL`, `*_ADDR`) |
| `confidence` | `high`, `medium` or `low` |
| `routable` | `true` only for `local_full` or `mock_min` at high or medium confidence whose write tools name the backend's objects: the pump routes only these. A low one keeps its class for the record, and is dispatched as today |
| `evidence` | `{ signal, backend, path, detail }`, at most 40: `dependency`, `dev_dependency`, `compose_image`, `prisma_provider`, `url_scheme`, `code_token`, `host_literal`, `env_name`, `openapi_file`, `fs_write`, `tool_names` |
| `write_tools` | `{ names_seen, write_like, sample }`: tool names found statically in the code, and how many look like writes |
| `basis` | `{ source: archive | root_files, commit, files_read, code_files_read, truncated }` and the versions of the two maps |

The two maps are data, so a backend, stand-in or spec is added without a code change. `none` is a
classification, never a finding: it means "not testable here", not "failed".

### What the pump sends a writecheck worker in a mode

`pump/workflows.json` `writecheck.modes` names each mode, the `write_backend` class it takes, and the repository
variable that turns it on: `LANE_WRITECHECK_FULL_ENABLED` for `full` (class `local_full`) and
`LANE_WRITECHECK_MIN_ENABLED` for `min` (class `mock_min`), each on only at exactly `"true"`. While a mode is on,
a subject whose latest accepted `write_backend` has that class is dispatched in that mode; other subjects are
dispatched as today, with none of the inputs below (`modes.unmatched: "default"`), so the plan and catalog
stages keep running for everyone. The mode, the backend and what it runs against go into the run_key
(`settings_state` becomes `<settings_state>+mode=<mode>+backend=<id>+via=<stand-in id, or the first 12 hex of the
spec URL's sha256>`), so a subject whose class, stand-in or spec changes is due again, and a full-mode result is
never filed as a default one.

A shard in a mode is homogeneous: every item has the same mode, backend id and stand-in (full) or spec URL
(min), so the worker starts one stand-in or one mock per shard. On top of the inputs in "Worker dispatch", such
a shard carries, all strings:

| Input | Sent | Value |
|---|---|---|
| `mode` | always in a mode shard | `full` or `min` |
| `backend` | always | the backend id, a key of `meta/data/stand-ins.json` or `meta/data/spec-urls.json`: `^[a-z0-9][a-z0-9_.-]{0,63}$` |
| `backend_kind` | always | the kind (table above) |
| `stand_in` | `full` only (empty for `min`) | the stand-in id from `meta/data/stand-ins.json`, such as `postgres`, `redis`, `minio`, `mailpit`: `^[a-z0-9][a-z0-9_.-]{0,63}$` |
| `spec_url` | `min` only (empty for `full`) | the API description's URL: https, no user, password or query, at most 512 characters; exactly one of `meta/data/spec-urls.json`'s, or the subject's own file at a full commit on raw.githubusercontent.com (`/<owner>/<name>/<40 hex>/...`) |
| `spec_format` | `min` only (empty for `full`) | the format (table above) |
| `env_names` | always | JSON, a list aligned with `items` (same length, same order): for each item the list of env var names its server reads, each `^[A-Z][A-Z0-9_]{0,63}$`, at most 20 per item, the `base_url_env` names first. The lane leaves out names that belong to the shell, the language runtimes and their option variables, the CI runner, the GitHub CLI and the container engine, credential agents, trust stores and git's own settings (meta/lib/backend-scan.mjs `ENV_DENY_RE`), and the pump filters again at dispatch; a worker should still treat the list as a request, not as permission. `[]` for an item with none |

GitHub allows 25 inputs on a `workflow_dispatch`; a mode shard uses 11 (`runner` is never sent to writecheck).
The inputs are public in the worker's run page like the rest: they hold backend and stand-in ids, a public spec
URL and env var names read from public repositories, never a value, a token or a canary.

### What the worker must do with them

- Treat every value as a **name to look up in its own allowlist**, pinned in the worker repository: a stand-in
  id maps to a fixture the worker pins by digest (as `loop/fixtures.json` does), a spec URL must be one the worker
  pins (host and path, or a content digest). An id or URL it does not know is a skip of ours (`stage: mode`,
  `reason: unsupported_layout`, `fault: tool`), never a reason to pull an image or fetch a URL named only by an
  input.
- Set only the env names it was given, to values that point at the stand-in or the mock inside the sandbox
  (connection strings, base URLs, dummy tokens); never a real credential; egress stays denied.
- Scope: the env names go only into the environment of the server's own child process in the sandbox. Never into
  `$GITHUB_ENV`, `$GITHUB_PATH`, a job's or a step's `env:`, the shell that runs the worker, or the environment of
  the worker's own tools (mcp-writecheck, the stand-in, the mock, the worker kit). A name the worker does not
  recognise as a server setting is dropped, not set.
- Report the mode it ran in every bundle: `results/writecheck.json` `mode`, and the harness basis on every
  requirement record (`basis: stand-in-product` for a real or faithful stand-in, `capture-sink` or
  `stateful-mock` for min). Backend-semantic requirements (UPD-1/2, CONC-1/2/3, TGT-1/3, RES-1, ATOM-2) are
  `not tested` under min mode, never `held`.
- A stand-in or mock that does not fit the server (it will not start against it, it wants an endpoint the mock
  lacks) is a skip with `fault: tool` (`stand_in_mismatch`, or `mock_incomplete`), never the server's failure.
  A classification we got wrong is our error too: the skip names the backend it was sent.
- Report `mode`, `backend` and `stand_in` or `spec_url` in the manifest's `tools` settings, so the run is
  auditable against the run_key.
- The auto-accepted plan of the stand-in run tier (owner decision, 27 Nov) applies only when every write
  target in the plan is the stand-in or the mock named by these inputs; anything else keeps today's
  person-accepted plan rule.

### Coverage in a mode

writecheck's coverage per mode (`state/coverage.mjs`, `modes: true`, the health issue) has as its denominator the
subjects whose latest `write_backend` has that mode's class, and counts as assessed in the mode only results filed
under it. Subjects classified `none` are reported beside it as "not testable here: hosted backend without a spec,
no write tools ..." with the reason counts, and subjects not yet classified as `unclassified`; neither is a
failure, and neither is in a mode's denominator. The lane's own four numbers stay those of the whole frame.

## Ingest in the pump

Ingest runs inside the pump process, so the pump stays the only writer.
[`pump/run.mjs`](../pump/run.mjs) builds one collector per run with
`createCollector()` from [`ingest/collect.mjs`](../ingest/collect.mjs) and,
at the start of every tick (every 150 seconds, and once in a housekeeping
run), calls:

```js
const summary = await collector.collect({ db, now, log, mintToken, deadline });
```

| Argument | What it is |
|---|---|
| `db` | The open state store (`state/db.mjs`). Ingest uses the calls below and never writes tables directly. |
| `now()` | The current time in ms (tests control it). |
| `log(line)` | Writes a line to the run log, with tokens and `AGE_IDENTITY` removed. |
| `mintToken({ repositories, permissions })` | Mints a GitHub App token. Ingest asks for `{ repositories: ['<worker repo>'], permissions: { actions: 'read' } }` and reuses it until five minutes before it expires. Returns `{ token, expiresAt }`. |
| `deadline` | Time in ms after which ingest starts no new attempt. |

Order inside one pump run:

1. Before the first tick, if the pump has worker slots and any workflow is
   enabled, `collector.check()` makes sure results can be judged:
   `worker-kit/ingest.pub` holds a real age key (not only comments), and
   `AGE_IDENTITY` is set and is the identity of a key in it. It makes no API
   calls. If it throws
   `IngestSetupError`, the pump logs why, dispatches nothing for the whole run,
   still reaps and pushes, and the run fails. `collect()` repeats the key
   checks whenever there is a dispatch to look at, so a housekeeping run with
   a bad key judges nothing either.
2. Each tick: reap expired dispatches, `collect()`, then the tick itself
   (dispatch), then a state push if anything changed. So a result judged in a
   tick is in the state before that tick's push, and a dispatch whose lease
   ran out is already closed when ingest looks at it: it is then only
   rechecked as a late result, at most every ten minutes for six hours, and
   can never hold up later ticks.
3. `collect()` is not called within two minutes of the run's end (the
   `deadline` is the run's end minus two minutes, about minute 9 of 11), so the
   last decisions are pushed with the final state.

What `collect()` does, oldest dispatch first, for each dispatch from
`db.dispatchesAwaitingResults()`:

| Situation | What happens |
|---|---|
| No run id yet | Look the run up by its name, `shard <shard_id>`, among `workflow_dispatch` runs of the worker workflow created since two minutes before the dispatch; store it with `db.setDispatchRun()`. None yet: wait. |
| Run not finished, or GitHub does not know it | Wait. A run that never finishes is handled by lease expiry. |
| Run finished | Check the run and list its artifacts once (`openAttempt()` in [`ingest/ingest.mjs`](../ingest/ingest.mjs), steps in [`ingest/README.md`](../ingest/README.md)). Then, for each item without a result, in index order: judge it against its own artifact `result-<attempt_id>-<index>.tar.age`, record the decision with `db.recordResult()`, and seal the item's outputs to `worker-kit/ingest.pub` as `ingest-<attempt_id>-<index>.tar.age` in the outputs directory. Recording and sealing one item are one transaction (`db.txAsync()`): if sealing fails, nothing is recorded for that item, the other items go on, and a later tick tries it again. Once every item has a result, the dispatch is closed as `run_completed` (frees its slot and any lease left), unless the store already closed it as `results_in`. |
| Refused before any item was judged | Unknown attempt, wrong repo or run, run not found: nothing is recorded, the report is sealed as `ingest-<attempt_id>.tar.age`, and the dispatch is closed. |
| Lease expired before ingest looked | Still judged for six hours after the dispatch was closed, at most every ten minutes (a look the API budget stopped does not count; R-CHAOS-07). A run that completed inside its lease is accepted if no newer lease was granted; one that completed later is kept as rejected. |

The `deadline` is checked before every item, so a large shard may be judged
over several ticks; items already recorded are skipped.

It returns a summary: `{ checked, waiting, judged, recorded, closed,
correlated, errors, stopped, outcomes, changed }`. `checked` and `waiting`
count dispatches; `judged`, `recorded` and `outcomes` count items; `errors`
counts failed items and dispatches. `stopped` is `budget` when the API
budget (pump/budgets.mjs; ingest's calls go through the same budget as the
pump's, in the `actions` and `artifacts` families) would have to wait,
`deadline`, or `registry` when the field registry could not be loaded; the
rest waits for the next tick. An error on one item is logged and
nothing is recorded for it. A transient GitHub or network error is tried
again next tick (the lease and the six-hour late window bound it). Any other
error (age cannot run, the ledger or sealing failed) is counted in the state
(`ingest.failures:<attempt_id>:<index>` in `kv`, kept even though the item's
transaction rolled back); on the third such failure the item is recorded as
rejected `ingest_error`, so no item is retried forever. Problems caused by a
downloaded bundle's contents are never thrown: they are recorded decisions
(`ingest_timeout`, `ingest_error` and the reasons in ingest/README.md). Any other error
thrown by `collect()` is logged and the tick goes on; `IngestSetupError` stops
dispatching for the rest of the run. The pump keeps the summary in
`pump.last_tick` (below).

The sealed outputs are uploaded by `pump.yml` at the end of the job as the
artifact `ingest-<run_id>-<run_attempt>` (docs/OPERATIONS.md, "Reading ingest
outputs").

The manual re-ingest workflow (`.github/workflows/ingest.yml`) runs the same
`ingestAttempt()` for one attempt through the command line, while the pump is
paused.

## State calls for ingest

### `db.getAttempt(attemptId)`

What ingest needs to know about a dispatch, or `undefined` if there is no
such attempt: `attempt_id`, `workflow`, `repo`, `workflow_file` (a path under
`.github/workflows/`), `run_id` (a number, or `null` until the run is known),
`workflow_sha`, `canaries` (always empty for now: none are injected yet),
`status`, `shard_id`, `created`, `expires`, and `items`, one per dispatched
item in dispatch order:
`{ index, run_key, fence, subject, subject_name, repo_id, name, current_fence, outcome, resolved, pins }`.
`pins` is `{ tool, probe }`, the versions the item's run_key was computed
from (`db.runKeyPins`), or `null` when the run_key's fields are not recorded
(then there is no label to check); ingest checks the bundle against it (R-PIN-01).
`subject` is the subject key the result is recorded under; `subject_name`
the owner/name the worker was sent (null for dispatches from before schema
v8); `repo_id` and `name` the subject's repository id (null until looked up)
and its name now. Ingest copies them into each item's `ingest.json`
(`ledger.subject`, `ledger.subject_name`, `ledger.repo_id`,
`ledger.subject_current_name`), and `longitudinal/` groups results by
`ledger.subject`, so one repository's history stays one subject across a
rename.
`retries` is the number of `retry_later` decisions for the item's run_key
since its last accepted result that measured something (`results.measured_at`;
a `skips_only` result does not reset it, R-SUB-08) (`db.retryLaterCount(runKey)`);
`throttled` and `throttled_since` are the number and first time of its
`retry_throttled` decisions since then (`db.retryThrottled(runKey)`). The row
also has `workflow`, the lane name, which ingest uses to look up the lane's
`throttle_stages` (R-SUB-09).

`recordResult` also takes `resultOutcome`, what the results row stores as its
outcome when the result is accepted (default: `outcome`). Ingest passes
`skips_only` for a bundle whose every skip is retryable (its retries ran out)
and that measured nothing: no observation with a value and no `results/` file
other than a skip's `evidence` (R-SUB-10). The due list looks at such a
result again after `skips_only_max_age_days`, doubling for each one in a row,
at most the tier max age (R-SUB-06, R-SUB-08). The results row keeps
`measured_at` and counts `skips_streak` for this.

`recordResult` also takes `fault` and `coverage` for an accepted result
(R-COV-02): the result's fault side (`tool`, `unknown`, `infra`, `subject`,
`policy`, or `null` with no skip) and coverage state (`assessed`,
`unassessed_tool`, `unassessed_unknown`, `unassessed_infra`, `subject`,
`excluded`), from `resultFault()` in `worker-kit/contract.mjs`. The results
row stores both (state schema 7) and keeps `assessed_at`, the last time the
run_key had an assessed result. A tool-fault skip is `unassessed_tool`:
never `excluded` and never the server's failure. Rows from before schema 7
have all three `NULL`. The due list reads them for the coverage-gap boost
(`pump/due.mjs`, R-COV-03).

`index` is the item's 0-based position in the `items` input the worker got,
which names its result artifact; `current_fence` is the fence of the
run_key's lease now (a newer one means this item is stale); `outcome` is
`null` until a result for this attempt, run_key and fence is recorded.
[`ingest/ledger.mjs`](../ingest/ledger.mjs) (`dbLedger()`) adapts it for
ingest.

### `db.dispatchesAwaitingResults({ now, lateMs })` and `db.setDispatchRun(attemptId, { runId, runUrl, correlatedBy })`

The first lists the dispatches ingest should look at: every open one
(`pending` or `dispatched`; the pump reaps expired ones before ingest runs)
and those closed as expired within `lateMs` that have a run id and nothing
recorded. The second stores the run found for a dispatch whose run id the
dispatch response did not return; `correlatedBy` says how it was found
(`run-name`). It never changes `workflow_sha`, the commit recorded when the
dispatch was created, which is what the run is checked against.

### `db.txAsync(fn)`

Runs an async `fn` in one write transaction and commits only if it resolves.
Safe only because the pump is the single writer and nothing else uses the
connection meanwhile.

### `db.getDispatch(attemptId)`

The dispatch row with its items, or `undefined`. Fields include `repo`,
`workflow`, `workflow_file`, `ref`, `status` (`pending`, `dispatched`, `done`,
`failed`, `expired`), `run_id`, `run_url`, `workflow_sha` and `expires`. Each
item has `item_index` (its 0-based position in the `items` input), `run_key`,
`subject`, `subject_name`, `fence` and `resolved`, in index order. Ingest uses it to check
that a result came from the run the pump started, in the repository and at the
workflow commit it expected.

### `db.recordResult({ run_key, attempt_id, fence, verdict, reason, outcome, digest, now })`

Stores one result after ingest has checked it. `verdict` is `accepted` or
`rejected` (ingest's own decision; ingest passes `accepted: true|false`
instead, which means the same); `reason` says why ingest rejected it.
`outcome` is ingest's outcome (`accepted`, `rejected`, `quarantined`);
`digest` is the sha256 of the stored result.

The store accepts the result only if all of these hold: the attempt exists, it
carries this `run_key` with this `fence`, that item has not reported already,
the fence is the run_key's current live lease, and ingest accepted it. It
returns `{ accepted, reason, id }`. `reason` is `null` when accepted, otherwise
one of the reasons below. An acceptance the store refuses is kept with outcome
`rejected`.

A call for an attempt, run_key and fence that already has a decision stores
nothing and returns the first decision with `duplicate: true`, so judging an
attempt twice (a retried tick, a manual re-ingest) is harmless and never turns
an earlier rejection into an acceptance.

| Reason | Meaning | Counts towards parking the run_key? |
|---|---|---|
| `unknown_attempt` | No such dispatch (for example state was restored from an older copy). | no |
| `unknown_run_key` | The dispatch did not carry this run_key. | no |
| `fence_mismatch` | The fence is not the one sent with this run_key. | no |
| `duplicate_result` | This item is already resolved without a recorded decision for this fence (not expected; repeats of a recorded decision return it with `duplicate: true` instead). | no |
| `stale_fence` | A newer lease exists; the work was sent out again. | no |
| `retry_throttled` | Every skip in the bundle is a retryable `rate_limited` or `upstream_unavailable` from a stage the lane declares in `throttle_stages` (`pump/workflows.json`; never the subject's own fetch or probe, R-SUB-09): the item is sent out again after the same backoff, capped at `retry_backoff_max_minutes`, for as long as 7 days after its run_key's first throttled retry (ingest `RETRY_WINDOW_MS`); not counted towards the three `retry_later` retries, which since R-SUB-04 are for other retryable skips only. Then the bundle is accepted with its skips. | no |
| `lease_expired`, `lease_released`, `no_lease`, `unknown_fence`, `holder_mismatch` | The lease is not live any more. | yes |
| `pin_mismatch`, `pin_unverified` | Ingest refused the result for its version pins (R-PIN-01, "Worker dispatch" above): our worker ran, or did not prove it ran, other code than the run_key is filed under. The lane is paused for an hour (`pausePinRefused`). | no |
| `run_sha_mismatch` | The worker run was at another commit than the one recorded at dispatch: the worker branch moved between the pump reading it and GitHub starting the run, or someone else's run took the shard's run name. The work is due again. Three such dispatches of one workflow in a row pause that workflow for six hours (`pump.paused:<workflow>` below). | no |
| `retry_later` | Every skip in the bundle is retryable (a rate limit, an upstream outage): the item is sent out again after a backoff (`retry_backoff_minutes` in `pump/tiers.json`, doubled for each retry), at most three times per run_key, then the bundle is accepted with its skips. | no |
| ingest's `reason`, or `rejected_by_ingest` | Ingest rejected the result. | yes |

`completedAt` (optional, ms or ISO): when GitHub says the worker run
completed. The lease's expiry is checked against it instead of `now` when it is
earlier, so a run that finished in time is not `lease_expired` because the pump
looked later (R-CHAOS-02). A newer lease still makes the fence stale. The
pump's ingest passes the run's `updated_at`, or the item's artifact
`created_at` when that is later (R-CHAOS-10); the manual re-ingest passes none.

Every call is kept as an attempt, accepted or not; a rejected result never
overwrites an accepted one. When the attempt is current, its lease is released.
When the last item of a dispatch reports, the dispatch is closed as
`results_in` and its slot is freed. A run_key with `max_rejections`
(`pump/tiers.json`) counted rejections since its last accepted result is
parked: it is not due again until its run_key changes (a new version of the
subject, or of our tools or settings).

### `releaseOnResult(db, attemptId, { reason, now })` (`pump/slots.mjs`)

Call it when a worker run has finished but did not report every item (it
failed, was cancelled, or lost some results), after recording the results it
did produce. It closes the dispatch with `reason`, frees its slot and releases
the leases of the items that did not report, so they are due again at once
instead of after the lease expires. It wraps `db.closeDispatch()` and returns
`false` if the dispatch was not open.

## Events (schema v10)

`events` is append-only: one row per thing the loop did, written by the pump
in the same transaction as the fact it describes, so an event commits only
with its fact (`state/schema-v10.sql`). A failed event never undoes or blocks
its fact: each insert runs in its own savepoint, and a failure rolls back only
that savepoint, is counted in kv `events.insert_failures`
(`{ count, last_at, last_type }`) and is logged as one line. Columns: `id` (the sequence;
AUTOINCREMENT, never reused), `type`, `occurred_at`, `recorded_at`, `lane`
(workflow, `NULL` for loop-wide events), `n` (how many things it counts),
`subject` (`subjects.id`, `NULL` unless the event is about one server) and
`data` (JSON; internal, never published as is). State pruning removes rows
after 8 days and always keeps the newest.

| type | Written by | lane, n | `data` |
|---|---|---|---|
| `dispatch_created` | `createDispatch` | workflow, items | `{ shard_id, items }` |
| `dispatch_sent` | `markDispatched` (now one transaction); `setDispatchRun` for a pending dispatch whose run was found by its run name | workflow, items | `{ run_id, run_url }`, plus `correlated_by: 'run-name'` from `setDispatchRun` |
| `dispatch_failed` | `failDispatch` | workflow, items | `{ status, withdrawn }`: the HTTP status of a refused call; `withdrawn` when it was never sent |
| `dispatch_unconfirmed` | `noteUnconfirmedDispatch` (the call may have started a run; the dispatch stays pending) | workflow, items | `{ status }` |
| `dispatch_expired` | `reapExpiredDispatches`, one per dispatch | workflow, items | `{}` |
| `result_recorded` | `recordResult`, fresh rows only (never a duplicate) | workflow, 1; `subject` | `{ verdict, reason, outcome, fault, coverage }` |
| `dispatch_closed` | `closeDispatch`, and `recordResult` when the last item reports | workflow, items | `{ close_reason }` |
| `pump_run_started`, `pump_run_finished` | `notePumpRun` at the start of a run and before its final push | | `{ ticks, dispatched }` |
| `successor` | `noteSuccessor` | | `{ ok, run_id, status }` |
| `registry_delta` | `noteRegistryDelta`, only when `action` is `dispatched` or `failed` | | `{ action }` |
| `breaker_changed` | `noteBreaker` | | `{ tripped, reason, held }` |
| `workflow_paused` | `noteShaMismatch` when it pauses (now one transaction) | workflow, 1 | `{ until }` |
| `frame_grew` | `pump/discover.mjs` `noteFrame`, when a discover pass added subjects | , subjects added | `{ version }`: the new frame version (kv `frame`) |
| `heads_polled` | `pump/heads.mjs`, one per GraphQL query applied, in the same transaction as its `noteHead` / `noteChange` writes | , repositories asked | `{ changed, head_first_seen, new_sha, new_release }` for that query |

State calls:

- `db.recordEvent({ type, occurredAt, lane, n, subject, data }, now)` appends
  one row (`occurredAt` defaults to `now`) and returns its id, or `null` when
  the insert failed (counted and logged, never thrown). Call it inside the
  transaction that writes the fact. Reasons, run URLs and lane names in
  `data` are cut to 200 characters.
- `db.listEvents({ sinceId = 0, limit = 1000 })`: rows with `id > sinceId`,
  oldest first, `data` parsed.
- `db.noteUnconfirmedDispatch(attemptId, { status, now })`: the event only;
  `false` unless the dispatch is pending.
- `db.notePumpRun('started' | 'finished', { ticks, dispatched, lastRun, occurredAt }, { now })`:
  with `lastRun` it also writes `pump.last_run`.
- `db.noteSuccessor(result, { now })`, `db.noteRegistryDelta(key, value, { now })`
  and `db.noteBreaker(key, value, { now })` write the kv record exactly as
  before (`pump.successor`, `pump.registry_delta`, `pump.breaker`) and the
  event, in one transaction.
- `db.failDispatch` takes `status` and `withdrawn`, and `db.markDispatched`
  and `db.setDispatchRun` take `now`, for their events.
- `db.log`: where a failed event insert is reported (stderr by default; the
  pump sets its own log).

## Leads (schema v12)

While `LANE_LEADS_ENABLED` is on (`dry-run`, `recheck` or `true`; see
docs/OPERATIONS.md, "Leads"), ingest turns every accepted result into its
leads: bug fingerprints in our own tools (`state/fingerprint.mjs`, the same
fingerprinting the check-in ranks by) and passes them to
`recordResult({ ..., failures })`. `recordResult` folds them with
`db.noteLeads(subject, lane, runKey, failures, { now, observedAt, runId, coverage })`
in the same transaction as the result, so a sighting commits exactly when its
result does (`state/schema-v12.sql`, rules in `state/leads.mjs`). With the
switch off ingest passes no `failures` and nothing is kept.

- `leads`: one row per fingerprint (the lead id is the fingerprint without tool
  versions or probe tools). Its shape columns (`SHAPE_COLUMNS`) are the only
  ones that may go into a public issue or job summary.
- `lead_subjects`: where each lead was seen, per (subject, lane): whether that
  pair's latest result carries it, counts, the 14-day log for the flake rate
  and the worker run of the newest result. It names subjects and stays in the
  state.
- `db.listLeads({ status })` and `db.leadSubjects(fingerprint)` read them.

## Keys the pump keeps in `kv`

| Key | Value |
|---|---|
| `pump.successor` | `{ ok, at, ref, runId?, error? }` from `pump/successor.mjs` for the current run. The watchdog reports `ok: false` as red. |
| `pump.last_tick` | The last tick's summary: due, planned, dispatched, failed, reaped, why it stopped early; `ingest` (checked, judged, recorded, outcomes, errors, why ingest stopped, or `null` if it did not run) `blocked` (why nothing may be dispatched this run, or `null`) and `breaker` (`{ tripped, reason, held }`, or `null` when no enabled workflow runs third-party code). |
| `pump.breaker` | The sandbox breaker as the run saw it (`pump/breaker.mjs`): `{ tripped, reason (red, stale, unreadable or null), summary, checked_at, run_url, sandbox_sha, held, mismatch: [{ lane, pins, tested }], at }`. Written when a run first judges it and whenever it changes. |
| `pump.conformance` | What the breaker remembers across runs: `{ newest, verified }`, each `{ run_id, run_attempt, checked_at, started_at, updated_at }`: the newest run verified against the Actions API (an older status is a rollback) and the verified green (not looked up again; aged by its `started_at`). Nothing is written before a run is verified. Reset: OPERATIONS.md, "The sandbox breaker". |
| `pump.last_run` | Start, finish, ticks, dispatched, failed and slot numbers of the last pump run. |
| `live.last_upload` | The live loop snapshot's last upload (live/publish.mjs): `ok`, `at`, `first_at`, `last_ok_at`, `last_ok_hour`, `last_snap`, `last_snap_put_at`, `seq`, `bytes`, `snap`, or `error` (`build`, `put`, `deadline`, `credentials`) / `blocked: scan` with `blocked_at` (kept until a good upload). Written only while `LANE_LIVE_SNAPSHOT_ENABLED` is `true`; the watchdog item `live-snapshot` reads it. |
| `pump.history_times` | `{ at, kinds: { 'registry-full' \| packages \| popularity: { last_capture_at } } }` from `pump/history-times.mjs`: the `updated_at` of the newest successful run of each history capture, read at most every 30 minutes and passed to the live snapshot as `config.history`. `at` is when every read last worked (null if none did yet); a failed read keeps that kind's older value. Written only while `LANE_LIVE_SNAPSHOT_ENABLED` is `true`. |
| `live.history.last_day` | The last UTC day (`YYYY-MM-DD`) whose daily history rollover finished: its day file (if any was missing), `v1/history/recent.json` and `v1/history/index.json` all stored (live/publish.mjs `publishHistory`). Written only after all three uploads succeed; while it is not the previous UTC day, every publish tries again. |
| `live.history.days` | Every day that has a file under `v1/history/days/`, sorted, uncapped (strings, ~13 bytes a day). Added the moment a day file's upload is confirmed, so a retry never builds that day again. The source of `index.json`. |
| `live.history.recent` | The day objects (`isokron-loop-day/1`) of the last 120 days with a file, oldest first, exactly as uploaded. The source of `recent.json`. |
| `live.history.pending` | `{ day, body }`: a day file built and about to be uploaded, or uploaded but not yet confirmed. Every retry sends exactly this body (never a rebuild) until the PUT succeeds and the day is recorded in `live.history.days` and `live.history.recent`; then it is removed. |
| `live.history.blocked` | The last 30 days the scan kept from being published, each day once: `[{ day, at, rules }]` (rule names only, never the text). A blocked day is not uploaded and not built again. |
| `pump.sha_mismatch:<workflow>` | `{ count, first, last, last_sha, burst_created }`: dispatches of that workflow in a row whose run was at another commit than the one recorded at dispatch (`run_sha_mismatch`). Mismatches with the same recorded commit whose dispatches were made within 30 s of the burst's first one are one burst and count once (`last_sha`, `burst_created`), so the shards of one tick that a merge overtook count as one; the same commit in a later tick counts again. The pump also reads the ref again just before each send. Removed when a run passes the checks. |
| `pump.paused:<workflow>` | `{ reason, count, since, until }`. `reason: 'run_sha_mismatch'`: set when that count reaches 3. `reason: 'pin_mismatch'` or `'pin_unverified'`: set by ingest at a result refused for its version pins (`db.pausePinRefused`, one hour, never shortening a longer pause; R-PIN-01). Until `until` the pump dispatches none of the workflow and every pump run fails, so the health issue shows it red; the pause ends on its own. |
| `pump.api_budget` | The pump's API budget (`ApiBudget.snapshot()`): the time of every API call in the last hour, per endpoint family, and any rate-limit block still in force. Saved before every push and restored at the start of the next run, so the hourly caps hold across runs rather than per run. |
| `ingest.failures:<attempt_id>:<index>` | `{ count, first, last, error }`: how often the pump failed to judge that item (not counting transient errors). Removed when the item is decided; at 3 it is recorded as `ingest_error`. |

## Public live snapshot (`live/`)

`buildLiveSnapshot(db, { now, config, retry, version })` (`live/build.mjs`)
returns `{ snapshot, hourEvents, previousHourEvents, problems }`: the
`isokron-loop-live/1` snapshot, the public file of the current UTC hour, the
file of the previous hour while the current one is under 300 s old (else
null; the uploader writes it again then), and the scan and size problems
(`[{rule, path}]`; any problem means nothing is uploaded). It is pure and
read-only: it reads `events`, `results`, `dispatches`, `slot_ledger`,
`subjects` and `kv`, never `dispatch_items`, `attempts`, `leases`,
`run_keys` or a digest. Dispatched work is public only as batch counts. No server name is published live: an
accepted result that is assessed or the server's own condition is named in
the next hour's file only, sorted by name; batch membership, per-item
rejections and quarantines are never published, and rejection classes are
per-lane daily totals with small counts suppressed. Public `seq` numbers are
not event ids. What is public and what never is: `live/README.md`.
