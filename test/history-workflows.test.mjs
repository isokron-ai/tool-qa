// history-popularity reads crate counts from the H2 crates subset that
// history-packages uploads. Before R-HIST-01 the workflow never passed that
// subset, so every weekly run failed on the seeded crates. The two steps that
// carry it are run here as GitHub would run them, with stub `gh` and `node`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../scripts/lib/yaml-lite.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const wf = parseYaml(readFileSync(join(ROOT, '.github/workflows/history-popularity.yml'), 'utf8'));
const job = wf.jobs.capture;
const step = (pred) => job.steps.find(pred);

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'hist-wf-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // gh: two successful history-packages runs, newest first; only the older one kept its crates files.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "gh $*" >> "${dir}/calls"
if [ "$1 $2" = "run list" ]; then printf '302\\n301\\n'; exit 0; fi
if [ "$1 $2" = "run download" ]; then
  [ "$3" = "301" ] || exit 1
  while [ $# -gt 0 ]; do if [ "$1" = "-D" ]; then d="$2"; fi; shift; done
  mkdir -p "$d/out"; echo old > "$d/out/crates-2026-11-20.ndjson.gz"; echo new > "$d/out/crates-2026-11-22.ndjson.gz"; exit 0
fi
exit 2
`);
  // node: record the arguments the capture step passes.
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/node-args"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'node'), 0o755);
  const work = join(dir, 'work');
  mkdirSync(work);
  writeFileSync(join(dir, 'out'), '');
  return { dir, bin, work, out: join(dir, 'out') };
}

function runStep(s, box, env) {
  return spawnSync('bash', ['-e', '-c', s.run], {
    cwd: box.work,
    encoding: 'utf8',
    env: { PATH: `${box.bin}:${process.env.PATH}`, GITHUB_OUTPUT: box.out, ...env },
  });
}

test('R-HIST-01: history-popularity fetches the newest crates subset and hands it to the capture step', () => {
  assert.equal(job.permissions.actions, 'read', 'the job may download history-packages artifacts');
  const fetchStep = step((s) => s.id === 'crates');
  const capture = step((s) => s.name === 'Capture popularity');
  assert.ok(fetchStep && capture);
  assert.match(fetchStep.if, /steps\.mode\.outputs\.mode != 'stars'/);
  assert.equal(capture.env.CRATES_SUBSET, '${{ steps.crates.outputs.path }}');

  const box = sandbox();
  try {
    const r = runStep(fetchStep, box, { REPO: 'isokron-ai/tool-qa', GH_TOKEN: 'x' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(box.dir, 'calls'), 'utf8'), /gh run list -R isokron-ai\/tool-qa -w history-packages -s success -L 10/);
    assert.equal(readFileSync(box.out, 'utf8'), 'path=.crates/subset.ndjson.gz\n');
    assert.equal(readFileSync(join(box.work, '.crates/subset.ndjson.gz'), 'utf8'), 'new\n', 'the newest crates file of the newest run that has one');

    const c = runStep(capture, box, { MODE: 'all', CRATES_SUBSET: '.crates/subset.ndjson.gz', GITHUB_TOKEN: 'x' });
    assert.equal(c.status, 0, c.stderr);
    const args = readFileSync(join(box.dir, 'node-args'), 'utf8').trim().split('\n');
    assert.deepEqual(args.slice(-2), ['--crates-subset', '.crates/subset.ndjson.gz']);

    const none = runStep(capture, box, { MODE: 'stars', CRATES_SUBSET: '', GITHUB_TOKEN: 'x' });
    assert.equal(none.status, 0, none.stderr);
    assert.ok(!readFileSync(join(box.dir, 'node-args'), 'utf8').includes('--crates-subset'));
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});

test('R-HIST-01: with no crates subset in the last runs, the fetch step warns and passes nothing', () => {
  const fetchStep = step((s) => s.id === 'crates');
  const box = sandbox();
  try {
    writeFileSync(join(box.bin, 'gh'), '#!/usr/bin/env bash\nif [ "$1 $2" = "run list" ]; then echo 9; exit 0; fi\nexit 1\n');
    const r = runStep(fetchStep, box, { REPO: 'isokron-ai/tool-qa', GH_TOKEN: 'x' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(box.out, 'utf8'), '');
    assert.match(r.stdout, /::warning title=history-popularity::No crates subset found/);
    assert.equal(existsSync(join(box.work, '.crates/subset.ndjson.gz')), false);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
});
