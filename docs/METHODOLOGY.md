# Coverage methodology

How the tool coverage numbers on the **Loop health** issue and in the live view's `coverage` block are computed. The code is `state/coverage.mjs`; the definitions are DESIGN section 4.7 (four numbers, never one alone). Each test is named in REGRESSIONS.md as `R-COV-20` to `R-COV-45`.

## The frame

The frame is the set of **active subjects in the state**: not retired, not gone, not merged into another. It is read from the state every time; no size is written in code. It is dated and versioned:

- If the state holds kv `frame.current` (`{version, dated}`, written by whatever job changes the population, for example discovery), that is the version and date (`frame from state`).
- Otherwise the version is `derived-<8 hex of a hash of the sorted subject ids>` and the date is the newest `first_seen` among them (`frame from derived`). The version changes whenever the member set changes.

A score is only ever read against a frame version. The pump records one compact entry per UTC day in kv `coverage.history`, each carrying the frame version it was measured on, so an old score is still readable against its own frame as well as the current one.

## Per lane

A lane is a worker workflow in `pump/workflows.json`. Lanes the live view draws as not built (`scan-deep`, `build-probe`) are left out. For a lane, a subject is **in the lane's frame** when its tier's cell in `pump/tiers.json` is `always` or `sample`, not `never`. A `sample` cell stays in the frame, so a tier the owner has not opened reads as low coverage rather than disappearing.

Each frame subject gets one state from the **newest accepted result** for that subject and lane (older results never count; a newer skip replaces an older assessment):

| State | From the result |
|---|---|
| excluded | coverage `excluded` (policy; the enum changes only by a human-approved PR) |
| assessed | coverage `assessed` |
| unsupported | coverage `subject` (the server's own limit) |
| tool limit | coverage `unassessed_tool` or `unassessed_unknown` (never excluded) |
| infra | coverage `unassessed_infra` |
| legacy | a result from before the coverage column |
| not reached | no accepted result yet |

Only `assessed` results can be judged. **Eligible** is the frame minus excluded.

## Correct and incorrect

A judgment says an assessed result was `correct` or `incorrect`. It is kept in kv `coverage.truth` keyed by the result's `run_key`, with its source (`qa_gate`, `resolved_disagreement`, `hand_review`) and time. Because the key is the result's run key, a judgment applies to that result only: a newer result for the pair has another run key and is unjudged until it is judged. `scripts/coverage-truth.mjs` records judgments from a list, or from the real-repo QA gate's per-repo table (a row is correct when it missed no tool and added no phantom). Oracle disagreements that a person resolved are entered the same way with source `resolved_disagreement`. Nothing is judged automatically.

## The four numbers

| Number | Computed as |
|---|---|
| Assessment coverage | assessed / eligible |
| Conditional correctness | correct / (correct + incorrect), over the judged results |
| Frame coverage | correct / eligible |
| Gross coverage | correct / frame |

Rules that follow from the data being partial:

- **Not yet measurable.** A lane with no judged result reports `null` ("not yet measurable") for conditional, frame and gross coverage. They are never 100% and never 0% on no evidence.
- **Conditional correctness is over what has been judged**, not over everything assessed, so it says how often the judged results were right. The judged count is always shown beside it. It equals the design's correct / assessed only when every assessed result has been judged.
- **Frame and gross coverage are lower bounds** until every assessed result is judged: they count only results confirmed correct.
- **Assessment coverage needs no judgment** and is exact.
- Numbers are rounded to four decimals and shown as percentages with one.

The contingency table on the health issue splits each lane by tier: frame, excluded, assessed, judged correct, judged incorrect. Splits by language, SDK, layout, protocol era and settings state, and weighting by downloads, wait for those fields to exist on the subjects.

## Milestones (G3)

- **M1**: lane pairs reached (a subject with at least one accepted result in an enabled lane) out of lane pairs in the frame.
- **M2** is measured on the frozen benchmark, outside the state; the block says so.
- **M3**: frame coverage of at least 0.98 on tiers T0 to T2, in every enabled lane. `null` (not yet measurable) until every enabled lane has a judged result; then true or false.

## Where it is published

- The **Loop health** issue, section "Tool coverage", written by the watchdog from its read-only copy of the state. The body is rewritten when a check changes or the coverage changes materially (a new frame version, a lane, a number turning measurable, M3 flipping, or a ratio moving by 0.1 percentage point; counts that drift alone do not rewrite it, so the shown counts can lag a little); a job that passes no coverage (mode merge) keeps the last one.
- The live view snapshot, as a new last key `coverage` (compact: frame version, date, size, per lane the counts and the four numbers, M1 and M3). Every earlier key is unchanged and the schema name stays `isokron-loop-live/1`. It is `null` when the state cannot answer.
- Importable by other jobs: `import { computeCoverage, compactCoverage } from '../state/coverage.mjs'`.
