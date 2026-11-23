import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkManifestIdentity, checkFiles, findIdentityClaims, checkControls, checkBundle,
} from '../forgery.mjs';
import { makeBundle, expected, defaultFiles, MARKER } from '../testkit.mjs';

const reasons = (errs) => errs.map((e) => e.reason);

test('a clean bundle passes every forgery check', () => {
  const b = makeBundle();
  assert.deepEqual(checkBundle(b.manifest, b.files, expected()), []);
});

test('manifest identity must match the dispatch', () => {
  const cases = [
    [{ identity: { attempt_id: 'att-2' } }, 'attempt_mismatch'],
    [{ identity: { fence: 6 } }, 'fence_mismatch'],
    [{ identity: { run_key: 'f'.repeat(64) } }, 'run_key_mismatch'],
    [{ workflow: { repo: 'someone/else' } }, 'workflow_repo_mismatch'],
    [{ workflow: { file: '.github/workflows/other.yml' } }, 'workflow_file_mismatch'],
    [{ workflow: { sha: '2'.repeat(40) } }, 'workflow_sha_mismatch'],
    [{ workflow: { run_id: 1 } }, 'run_id_mismatch'],
    [{ workflow: { run_attempt: 2 } }, 'run_attempt_mismatch'],
  ];
  for (const [opts, reason] of cases) {
    const b = makeBundle(opts);
    assert.deepEqual(reasons(checkManifestIdentity(b.manifest, expected())), [reason], reason);
  }
  // A later attempt of the same run is fine as long as the run has reached it.
  const b = makeBundle({ workflow: { run_attempt: 2 } });
  assert.deepEqual(checkManifestIdentity(b.manifest, expected({ run_attempt: 3 })), []);
  // Without a known workflow SHA that check is skipped, not failed.
  assert.deepEqual(checkManifestIdentity(makeBundle().manifest, expected({ workflow_sha: null })), []);
});

test('files must be exactly the listed ones, byte for byte', () => {
  const unlisted = makeBundle({ extraTarEntries: [['results/extra.json', '{}']] });
  assert.deepEqual(reasons(checkFiles(unlisted.manifest, unlisted.files)), ['unlisted_file']);

  const missing = makeBundle({ dropFromTar: ['logs/run.log'] });
  assert.deepEqual(reasons(checkFiles(missing.manifest, missing.files)), ['missing_file']);

  const swapped = makeBundle();
  // Same length, different bytes.
  swapped.files.set('results/report.json', Buffer.from(JSON.stringify({ tool: 'check', ok: null, findings: [] })));
  assert.deepEqual(reasons(checkFiles(swapped.manifest, swapped.files)), ['digest_mismatch']);

  const resized = makeBundle();
  resized.files.set('logs/run.log', Buffer.from('started\n'));
  assert.deepEqual(reasons(checkFiles(resized.manifest, resized.files)), ['size_mismatch']);
});

test('identity claims outside raw/ must not name another attempt', () => {
  const files = defaultFiles();
  // Same identity repeated in a report: fine.
  files['results/report.json'] = JSON.stringify({ attempt_id: 'att-1', fence: 7, nested: { run_key: 'a'.repeat(64) } });
  assert.deepEqual(findIdentityClaims(makeBundle({ files }).files, expected()), []);

  const json = defaultFiles();
  json['results/report.json'] = JSON.stringify({ items: [{ meta: { fencing_no: 8 } }] });
  const e1 = findIdentityClaims(makeBundle({ files: json }).files, expected());
  assert.deepEqual(e1.map((e) => [e.reason, e.path, e.key]), [['foreign_identity_claim', 'results/report.json', 'fencing_no']]);
  assert.equal(e1[0].json_path, '$.items[0].meta.fencing_no');

  const ndjson = defaultFiles();
  ndjson['observations/check.ndjson'] += `${JSON.stringify({ field: 'registry_name', value: 'x', attempt_id: 'att-2' })}\n`;
  const e2 = findIdentityClaims(makeBundle({ files: ndjson }).files, expected());
  assert.deepEqual(e2.map((e) => [e.reason, e.path, e.line]), [['foreign_identity_claim', 'observations/check.ndjson', 3]]);

  const text = defaultFiles();
  text['logs/run.log'] = 'ok\nrun_key=' + 'b'.repeat(64) + '\n';
  const e3 = findIdentityClaims(makeBundle({ files: text }).files, expected());
  assert.deepEqual(e3.map((e) => [e.reason, e.path, e.key]), [['foreign_identity_claim', 'logs/run.log', 'run_key']]);

  // Claims of any shape are fine inside raw/: those are target bytes.
  const raw = defaultFiles();
  raw['raw/other.json'] = JSON.stringify({ attempt_id: 'att-3', run_key: 'e'.repeat(64) });
  assert.deepEqual(findIdentityClaims(makeBundle({ files: raw }).files, expected()), []);
});

test('controls: failures, missing controls and forgery containment', () => {
  const ok = makeBundle();
  assert.deepEqual(checkControls(ok.manifest, ok.files), []);

  const failed = makeBundle({ meta: { controls: [{ kind: 'known_bad', expected: 'flagged', observed: 'clean' }] } });
  assert.deepEqual(reasons(checkControls(failed.manifest, failed.files)), ['control_failed']);

  const none = makeBundle({ meta: { controls: [] } });
  assert.deepEqual(reasons(checkControls(none.manifest, none.files)), ['control_missing']);
  assert.deepEqual(checkControls(none.manifest, none.files, { requireControl: false }), []);

  // The forged envelope was parsed into the control output as structure.
  const injected = defaultFiles();
  injected['controls/forgery.json'] = JSON.stringify({ verdict: 'contained', result: { attempt_id: 'att-999', fence: 99 } });
  const bi = makeBundle({ files: injected });
  assert.deepEqual(reasons(checkControls(bi.manifest, bi.files)), ['forgery_control_injected']);

  // A manifest-shaped object (schema_version + files) counts as an envelope too.
  const envelope = defaultFiles();
  envelope['controls/forgery.json'] = JSON.stringify({ verdict: 'contained', schema_version: 1, files: [] });
  const be = makeBundle({ files: envelope });
  assert.deepEqual(reasons(checkControls(be.manifest, be.files)), ['forgery_control_injected']);

  // The marker shows up in the control output.
  const quoted = defaultFiles();
  quoted['controls/forgery.json'] = JSON.stringify({ verdict: 'contained', saw: MARKER });
  const bq = makeBundle({ files: quoted });
  assert.deepEqual(reasons(checkControls(bq.manifest, bq.files)), ['forgery_control_injected']);

  // The marker leaked into a result or observation file.
  const leaked = defaultFiles();
  leaked['results/report.json'] = JSON.stringify({ tool: 'check', description: `see ${MARKER}` });
  const bl = makeBundle({ files: leaked });
  assert.deepEqual(reasons(checkControls(bl.manifest, bl.files)), ['forgery_marker_leaked']);

  // The marker never reached raw/: the control did not run.
  const unrun = defaultFiles();
  unrun['raw/forgery-target.ndjson'] = '{}\n';
  const bu = makeBundle({ files: unrun });
  assert.deepEqual(reasons(checkControls(bu.manifest, bu.files)), ['forgery_control_unverified']);

  // A control output kept in raw/ can't be checked.
  const inRaw = makeBundle({
    meta: { controls: [{ kind: 'forgery', expected: 'contained', observed: 'contained', output: 'raw/forgery-target.ndjson', marker: MARKER }] },
  });
  assert.deepEqual(reasons(checkControls(inRaw.manifest, inRaw.files)), ['control_output_in_raw']);
});

test('checkBundle reports forged manifests and files together, first problem first', () => {
  const files = defaultFiles();
  files['results/report.json'] = JSON.stringify({ attempt_id: 'att-2' });
  const b = makeBundle({ identity: { fence: 5 }, files, extraTarEntries: [['results/x.txt', 'x']] });
  const errs = checkBundle(b.manifest, b.files, expected());
  assert.deepEqual(reasons(errs), ['fence_mismatch', 'unlisted_file', 'foreign_identity_claim']);
  // Problems never carry file contents.
  assert.ok(errs.every((e) => !JSON.stringify(e).includes('att-2')));
});

test('R-ING-02: identity claims in a 1 MiB text file are found in linear time', async () => {
  const { lineIndex } = await import('../forgery.mjs');
  // Every line is a foreign claim. lineAt() used to count newlines from the
  // start of the file for each claim: 66 s on this input.
  const text = 'attempt_id=x\n'.repeat(Math.ceil(1024 ** 2 / 13));
  const t0 = performance.now();
  const out = findIdentityClaims(new Map([['results/claims.txt', Buffer.from(text)]]), expected());
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  assert.equal(out.length, 50, 'problems stay capped');
  assert.deepEqual(out.slice(0, 3).map((p) => p.line), [1, 2, 3]);

  const at = lineIndex('a\nbb\n\nccc');
  assert.deepEqual([0, 1, 2, 4, 5, 6, 8].map(at), [1, 1, 2, 2, 3, 4, 4]);
});
