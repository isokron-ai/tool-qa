# Measurements: separate, never one score

This is the rule for everything the loop measures or publishes about a server.
It is written down so that no later page, feed or leaderboard drifts into a
single grade.

## The rule

1. **Six separate claims.** Each of these says something different about a
   server, and they are never added, averaged, weighted or ranked into one
   grade or score:
   - protocol and conformance
   - catalog and tool-definition quality
   - behaviour
   - write safety
   - supply chain and release provenance
   - hardening
2. **Every published measurement names its lane, the tool version and the
   date.** A number without them is not published.
3. **Untested is not failed.** A server we have not run, or could not assess,
   never looks like one that failed. The coverage state (tested, skipped,
   not applicable, not yet reached) and the fault side (tool, subject, infra,
   policy) are shown as what they are, next to the measurement.
4. **A skip on our side is our limit.** If our tool could not do the check, the
   row says so and the server is not marked down for it. A tool error is
   published as an error, never as a failed check.
5. **Security issues are held.** An actual security issue is never shown, not
   even as a count, until its disclosure window ends. Hardening findings and
   tool issues are different: they are public, by company and repo name, after
   a person has confirmed them.

## How it is kept

[`test/measurements.test.mjs`](../test/measurements.test.mjs) reads the pinned
field registry (`meta/test/fixtures/registry-pinned.yaml`) and the loop's own
source. It fails if:

- a registry field is named like a combined measure (`score`, `grade`,
  `rating`, `rank`, `overall`, `composite`, `combined`);
- a registry layer has no lane here, so a new layer has to be placed in one
  lane (or marked as not a measurement) on purpose;
- loop code emits an observation field named like a combined measure.

Third parties' own results stay inside their lane under their own name, for
example `scorecard_result` in supply chain.

The registry itself lives in `isokron-ai/mcp-results`; the tool-qa pin moves
only on purpose (`ingest/registry.mjs`).

## Notes on the ledger's cycle times

- Dates for a row or a test come from the history of its path on the default
  branch, read without `--follow`. A file that was renamed or moved shows the
  date of the rename, not the original.
- A history longer than 500 commits is cut; when the oldest commit read still
  has the row or test, the date is left unknown rather than guessed.
- "Left out" in the cycle table counts rows (once each) that have a gap
  running backwards, not gaps.
- Hardening has no registry layer yet. Until it has one, its findings are
  class B observations in the layers where they were seen, and the lane list
  above is a rule for what may be published, not a field in the registry.
