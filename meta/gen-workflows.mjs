#!/usr/bin/env node
// Writes the metadata lanes' workflows. A workflow cannot loop over a `uses:`
// step, so each worker has one worker-kit step per item slot (100, the
// shard_size in pump/workflows.json); generating them keeps the slots alike.
//
//   node meta/gen-workflows.mjs           write the files
//   node meta/gen-workflows.mjs --check   exit 1 if a committed file differs
//
// meta/test/workflows.test.mjs runs the check, so a hand edit is caught.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SLOTS = 100;
/** Item slots per lane: the shard_size in pump/workflows.json. */
export const LANE_SLOTS = Object.freeze({ 'meta-github': 100, 'meta-registry': 100, 'release-diff': 20 });
export const PINS = Object.freeze({
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  setupNode: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
  cacheRestore: 'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
  cacheSave: 'actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
  // The tool-qa commit whose worker kit seals and uploads the bundles. Every lane's skips say their fault side
  // (too_large, tool_error, reader_limit, unsupported_layout with fault tool; rate_limited with fault infra), which
  // the kit knows from 2ffcea1 on (R-COV-01); the same pin as mcp-check's scan-static (R-META-10).
  workerKit: 'isokron-ai/tool-qa/worker-kit@2ffcea16117ec679398f83eefe8c6fa66d38bac6 # main at 2ffcea1 (skip fault sides)',
});
const ROOT = new URL('../', import.meta.url);

const ABOUT = {
  'meta-github': [
    'Loop worker (internal): the meta-github lane. The tool-qa pump dispatches it with shard_id, attempt_id and',
    'items (docs/INTERFACES.md, "Worker dispatch"); each item is a public GitHub repository, owner/name.',
    'meta/run.mjs reads public metadata about each one (repository facts, releases, contributor count, issue and',
    'pull request counts, security policy, public branch rules, community and workflow files, OpenSSF Scorecard)',
    'through the GitHub GraphQL and REST APIs and api.scorecard.dev. No code from a subject is fetched or run, so',
    'no sandbox is needed. The worker kit seals one bundle per item to the ingest key and uploads it as',
    'result-<attempt_id>-<i>.tar.age. meta/README.md says what a bundle holds.',
  ],
  'meta-registry': [
    'Loop worker (internal): the meta-registry lane. The tool-qa pump dispatches it with shard_id, attempt_id',
    'and items (docs/INTERFACES.md, "Worker dispatch"); each item is a public GitHub repository, owner/name.',
    'meta/run.mjs reads what the official MCP registry, npm, PyPI, crates.io, the Go module proxy and deps.dev',
    'say about each one (entry history, versions, publish dates, maintainer counts, provenance, deprecations).',
    'No package is installed or run, so no sandbox is needed. The worker kit seals one bundle per item to the',
    'ingest key and uploads it as result-<attempt_id>-<i>.tar.age. meta/README.md says what a bundle holds.',
  ],
  'release-diff': [
    'Loop worker (internal): the release-diff lane. The tool-qa pump dispatches it with shard_id, attempt_id and',
    'items (docs/INTERFACES.md, "Worker dispatch"); each item is a public GitHub repository, owner/name.',
    'meta/run.mjs compares each npm tarball, PyPI sdist and wheel the repository publishes with the source at the',
    'version\'s tag: tags, provenance, unexpected or differing files, install scripts, manifests. Artifacts come',
    'only from registry.npmjs.org and files.pythonhosted.org, the source from codeload.github.com; both are read',
    'in memory with our own archive readers and nothing from them is installed, imported or run, so no sandbox is',
    'needed. The worker kit seals one bundle per item to the ingest key and uploads it as',
    'result-<attempt_id>-<i>.tar.age. meta/README.md says what a bundle holds.',
  ],
};

const SECURITY = [
  'Security: workflow_dispatch only, from main; permissions: {} at the top and contents: read for the job.',
  'No secrets. The inputs reach steps through env: only and are checked whole before anything is read. The',
  'kill switch (LOOP_ENABLED first, then scripts/guard.mjs: LOOP_PAUSE_UNTIL and the lane switch) stops the lane',
  'without failing a run. Actions are pinned by full SHA. Controls run before any subject is read; if one',
  'fails, nothing is uploaded.',
];

function inputChecks(indent, slots = SLOTS) {
  const p = ' '.repeat(indent);
  return [
    `${p}# Whole-string checks: a newline or control character anywhere fails the match. meta/run.mjs checks`,
    `${p}# the items in full (JSON, 1 to ${slots} entries, run_key, fence) before anything is read.`,
    `${p}id_re='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'`,
    `${p}items_re='^\\[[^[:cntrl:]]+\\]$'`,
    `${p}if [[ ! "$SHARD_ID" =~ $id_re ]]; then echo "::error::shard_id is malformed"; exit 1; fi`,
    `${p}if [[ ! "$ATTEMPT_ID" =~ $id_re ]]; then echo "::error::attempt_id is malformed"; exit 1; fi`,
    `${p}if [[ ! "$ITEMS" =~ $items_re ]] || [ "\${#ITEMS}" -gt 60000 ]; then echo "::error::items must be one line of JSON, a list of at most 60000 characters"; exit 1; fi`,
  ];
}

function kitSteps({ uses, dryRun, dryRunExpr, attemptExpr, outDir, slots = SLOTS }) {
  const lines = [];
  for (let i = 0; i < slots; i++) {
    lines.push(
      `      - name: Seal ${dryRunExpr ? 'and check or upload' : dryRun ? 'and check' : 'and upload'} item ${i}`,
      `        if: \${{ !cancelled() && steps.collect.outcome == 'success' && steps.collect.outputs.has_${i} == 'true' }}`,
      `        uses: ${uses}`,
      '        with:',
      `          bundle-dir: \${{ runner.temp }}/${outDir}/${i}/bundle`,
      `          meta-file: \${{ runner.temp }}/${outDir}/${i}/meta.json`,
      `          attempt-id: ${attemptExpr}`,
      `          item-index: '${i}'`,
      `          fence: \${{ steps.collect.outputs.fence_${i} }}`,
      `          run-key: \${{ steps.collect.outputs.run_key_${i} }}`,
    );
    if (dryRunExpr) lines.push(`          dry-run: ${dryRunExpr}`);
    else if (dryRun) lines.push("          dry-run: 'true'");
  }
  return lines;
}

export function workerWorkflow(lane) {
  const laneVar = `LANE_${lane.toUpperCase().replace(/-/g, '_')}_ENABLED`;
  const isGithub = lane === 'meta-github';
  const slots = LANE_SLOTS[lane];
  const lease = lane === 'release-diff'
    ? ['    # Below the pump\'s lease for a shard of 20: 1.5 x (2 + 20 x 1) + 10 = 43 minutes. meta/run.mjs starts',
      '    # no subject after 22 minutes; those not started report a retryable skip. A subject starts no download',
      '    # after 6 minutes, and each download has 2.']
    : ['    # Below the pump\'s lease for a shard of 100: 1.5 x (2 + 100 x 0.2) + 10 = 43 minutes. meta/run.mjs starts',
      '    # no subject after 22 minutes; those not started report a retryable skip.'];
  return [
    ...ABOUT[lane].map((l) => `# ${l}`),
    '#',
    ...SECURITY.map((l) => `# ${l}`),
    isGithub
      ? '# The job token reads public data only (GitHub allows it 1,000 REST requests and 1,000 GraphQL points an hour for this repository); meta/github.mjs keeps a reserve and records a retryable skip past it.'
      : '# No GitHub API is called; the job token is not passed to the script.',
    '#',
    '# Generated by meta/gen-workflows.mjs: edit that file, not this one.',
    '',
    `name: ${lane}`,
    '',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      shard_id:',
    `        description: Shard id from the tool-qa pump, such as ${lane}-3f2a9c01b7d4.`,
    '        required: true',
    '        type: string',
    '      attempt_id:',
    '        description: Attempt id from the tool-qa pump; every result quotes it.',
    '        required: true',
    '        type: string',
    '      items:',
    `        description: 'JSON list of 1 to ${slots} {"subject": "owner/name", "run_key": "<64 hex>", "fence": <n>}.'`,
    '        required: true',
    '        type: string',
    '',
    'run-name: shard ${{ inputs.shard_id }}',
    '',
    'permissions: {}',
    '',
    'concurrency:',
    `  group: ${lane}-\${{ inputs.shard_id }}`,
    '  cancel-in-progress: false',
    '',
    'jobs:',
    '  collect:',
    `    name: ${lane}`,
    "    if: github.repository == 'isokron-ai/tool-qa' && github.ref == 'refs/heads/main'",
    '    runs-on: ubuntu-24.04',
    ...lease,
    '    timeout-minutes: 40',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      # First, before anything is checked out: LOOP_ENABLED must be exactly "true". Off is a notice, not a failure.',
    '      - id: enabled',
    '        name: Kill switch (LOOP_ENABLED)',
    '        env:',
    '          LOOP_ENABLED: ${{ vars.LOOP_ENABLED }}',
    '        run: |',
    '          if [[ "$LOOP_ENABLED" == "true" ]]; then echo "on=true" >> "$GITHUB_OUTPUT"',
    `          else echo "::notice title=${lane}::LOOP_ENABLED is not \\"true\\"; the loop is off and nothing is read"; fi`,
    "      - if: steps.enabled.outputs.on == 'true'",
    `        uses: ${PINS.checkout}`,
    '        with:',
    '          persist-credentials: false',
    '      - id: guard',
    "        if: steps.enabled.outputs.on == 'true'",
    `        name: Kill switch (LOOP_PAUSE_UNTIL, ${laneVar})`,
    '        env:',
    '          LOOP_ENABLED: ${{ vars.LOOP_ENABLED }}',
    '          LOOP_PAUSE_UNTIL: ${{ vars.LOOP_PAUSE_UNTIL }}',
    `          ${laneVar}: \${{ vars.${laneVar} }}`,
    `        run: node scripts/guard.mjs --job ${lane} --no-slots`,
    '      - name: Check the inputs',
    "        if: steps.guard.outputs.proceed == 'true'",
    '        env:',
    '          SHARD_ID: ${{ inputs.shard_id }}',
    '          ATTEMPT_ID: ${{ inputs.attempt_id }}',
    '          ITEMS: ${{ inputs.items }}',
    '        run: |',
    ...inputChecks(10, slots),
    "      - if: steps.guard.outputs.proceed == 'true'",
    `        uses: ${PINS.setupNode}`,
    '        with:',
    "          node-version: '22'",
    '          package-manager-cache: false',
    '      # The conditional-request cache: ETags and the summaries read with them, no response bodies.',
    "      - if: steps.guard.outputs.proceed == 'true'",
    `        uses: ${PINS.cacheRestore}`,
    '        with:',
    `          path: \${{ runner.temp }}/meta-cache/${lane}.json`,
    `          key: ${lane}-http-v1-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    `          restore-keys: ${lane}-http-v1-`,
    '      - id: collect',
    "        if: steps.guard.outputs.proceed == 'true'",
    '        name: Read the subjects',
    '        env:',
    '          SHARD_ID: ${{ inputs.shard_id }}',
    '          ATTEMPT_ID: ${{ inputs.attempt_id }}',
    '          ITEMS: ${{ inputs.items }}',
    `          META_CACHE_FILE: \${{ runner.temp }}/meta-cache/${lane}.json`,
    ...(isGithub ? ['          GITHUB_TOKEN: ${{ github.token }}'] : []),
    '        run: |',
    '          mkdir -p "$RUNNER_TEMP/meta-cache"',
    `          node meta/run.mjs ${lane} "$RUNNER_TEMP/meta-out"`,
    "      - if: ${{ !cancelled() && steps.collect.outcome == 'success' }}",
    `        uses: ${PINS.cacheSave}`,
    '        with:',
    `          path: \${{ runner.temp }}/meta-cache/${lane}.json`,
    `          key: ${lane}-http-v1-\${{ github.run_id }}-\${{ github.run_attempt }}`,
    `      # One step per item slot (has_<i> is set for every dispatched item). One item's failed upload does not stop the others.`,
    ...kitSteps({ uses: PINS.workerKit, dryRun: false, attemptExpr: '${{ inputs.attempt_id }}', outDir: 'meta-out', slots }),
    '',
  ].join('\n');
}

export function fixtureWorkflow() {
  return [
    '# Fixture run of the metadata lanes on every pull request that touches them: the real APIs, three of our own',
    '# repositories, the same script and the same 100 worker-kit slots (the same pinned kit) as the workers.',
    '# mode check: the kit builds every bundle in dry-run mode and meta/fixture.mjs judges each one with ingest\'s',
    '# own checks against the pinned field registry; the job fails unless each is accepted.',
    '# mode upload: the kit runs as the workers run it (install age, encrypt to the ingest key, upload a 3-day',
    '# artifact), which measures the time per item slot (meta/README.md, "Runtime"). Ingest never reads pull request runs.',
    '#',
    '# Security: pull_request only (no pull_request_target), permissions: {} at the top and contents: read for the',
    '# job, no secrets; the job token reads public data. Actions are pinned by full SHA.',
    '#',
    '# Generated by meta/gen-workflows.mjs: edit that file, not this one.',
    '',
    'name: meta-fixture',
    '',
    'on:',
    '  pull_request:',
    '    paths:',
    "      - 'meta/**'",
    "      - 'worker-kit/**'",
    "      - 'ingest/**'",
    "      - '.github/workflows/meta-*.yml'",
    "      - '.github/workflows/release-diff.yml'",
    "      - 'scripts/lib/untar.mjs'",
    "      - 'scripts/lib/unzip.mjs'",
    '',
    'permissions: {}',
    '',
    'concurrency:',
    '  group: meta-fixture-${{ github.ref }}',
    '  cancel-in-progress: true',
    '',
    'jobs:',
    '  fixture:',
    '    name: fixture (${{ matrix.lane }}, ${{ matrix.mode }})',
    '    runs-on: ubuntu-24.04',
    '    timeout-minutes: 30',
    '    permissions:',
    '      contents: read',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    '        lane: [meta-github, meta-registry]',
    '        mode: [check, upload]',
    '    steps:',
    `      - uses: ${PINS.checkout}`,
    '        with:',
    '          persist-credentials: false',
    `      - uses: ${PINS.setupNode}`,
    '        with:',
    "          node-version: '22'",
    '          package-manager-cache: false',
    '      - id: items',
    '        name: Fixture items',
    '        env:',
    '          LANE: ${{ matrix.lane }}',
    '          MODE: ${{ matrix.mode }}',
    '        run: node meta/fixture.mjs items "$LANE" "$MODE" >> "$GITHUB_OUTPUT"',
    '      - id: collect',
    '        name: Read the fixture subjects (real APIs)',
    '        env:',
    '          LANE: ${{ matrix.lane }}',
    '          SHARD_ID: ${{ steps.items.outputs.shard_id }}',
    '          ATTEMPT_ID: ${{ steps.items.outputs.attempt_id }}',
    '          ITEMS: ${{ steps.items.outputs.items }}',
    '          GITHUB_TOKEN: ${{ github.token }}',
    '        run: |',
    ...inputChecks(10),
    '          node meta/run.mjs "$LANE" "$RUNNER_TEMP/meta-out"',
    ...kitSteps({ uses: PINS.workerKit, dryRunExpr: "${{ matrix.mode == 'check' && 'true' || 'false' }}", attemptExpr: '${{ steps.items.outputs.attempt_id }}', outDir: 'meta-out' }),
    '      - name: Judge every bundle with ingest\'s checks',
    "        if: matrix.mode == 'check'",
    '        env:',
    '          LANE: ${{ matrix.lane }}',
    '          ATTEMPT_ID: ${{ steps.items.outputs.attempt_id }}',
    '          ITEMS: ${{ steps.items.outputs.items }}',
    '        run: node meta/fixture.mjs judge "$LANE" "$RUNNER_TEMP/tool-qa-result" "$RUNNER_TEMP/meta-out"',
    ...releaseDiffFixtureJob(),
    '',
  ].join('\n');
}

/** release-diff's fixture job: our own published packages, 20 slots. */
function releaseDiffFixtureJob() {
  const slots = LANE_SLOTS['release-diff'];
  return [
    '  # release-diff reads our own published packages (meta/fixture.mjs FIXTURE_SUBJECTS) with the kit pin that knows',
    '  # skip fault sides; it prints each subject\'s runtime and findings.',
    '  release-diff-fixture:',
    '    name: fixture (release-diff, ${{ matrix.mode }})',
    '    runs-on: ubuntu-24.04',
    '    timeout-minutes: 30',
    '    permissions:',
    '      contents: read',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    '        mode: [check, upload]',
    '    steps:',
    `      - uses: ${PINS.checkout}`,
    '        with:',
    '          persist-credentials: false',
    `      - uses: ${PINS.setupNode}`,
    '        with:',
    "          node-version: '22'",
    '          package-manager-cache: false',
    '      - id: items',
    '        name: Fixture items',
    '        env:',
    '          MODE: ${{ matrix.mode }}',
    '        run: node meta/fixture.mjs items release-diff "$MODE" >> "$GITHUB_OUTPUT"',
    '      - id: collect',
    '        name: Read the fixture subjects (real registries, no token)',
    '        env:',
    '          SHARD_ID: ${{ steps.items.outputs.shard_id }}',
    '          ATTEMPT_ID: ${{ steps.items.outputs.attempt_id }}',
    '          ITEMS: ${{ steps.items.outputs.items }}',
    '        run: |',
    ...inputChecks(10, slots),
    '          node meta/run.mjs release-diff "$RUNNER_TEMP/meta-out"',
    ...kitSteps({ uses: PINS.workerKit, dryRunExpr: "${{ matrix.mode == 'check' && 'true' || 'false' }}", attemptExpr: '${{ steps.items.outputs.attempt_id }}', outDir: 'meta-out', slots }),
    '      - name: Judge every bundle with ingest\'s checks',
    "        if: matrix.mode == 'check'",
    '        env:',
    '          ATTEMPT_ID: ${{ steps.items.outputs.attempt_id }}',
    '          ITEMS: ${{ steps.items.outputs.items }}',
    '        run: node meta/fixture.mjs judge release-diff "$RUNNER_TEMP/tool-qa-result" "$RUNNER_TEMP/meta-out"',
  ];
}

export const FILES = Object.freeze({
  '.github/workflows/meta-github.yml': () => workerWorkflow('meta-github'),
  '.github/workflows/meta-registry.yml': () => workerWorkflow('meta-registry'),
  '.github/workflows/release-diff.yml': () => workerWorkflow('release-diff'),
  '.github/workflows/meta-fixture.yml': () => fixtureWorkflow(),
});

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  let differ = 0;
  for (const [rel, gen] of Object.entries(FILES)) {
    const path = new URL(rel, ROOT);
    const want = gen();
    if (check) {
      let have = null;
      try { have = readFileSync(path, 'utf8'); } catch { /* missing */ }
      if (have !== want) { differ++; process.stdout.write(`${rel} differs from meta/gen-workflows.mjs\n`); }
    } else {
      writeFileSync(path, want);
    }
  }
  return differ ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
