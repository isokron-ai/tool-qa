#!/usr/bin/env node
// The keep-forever copy: a second durable home for the keep-forever set, as
// GitHub release assets on this repository (loop upgrade 20).
//
//   node keep/copy.mjs
//
// What it copies, from the Actions artifacts GitHub still holds (90 days):
//   ingest-keep-<run>-<attempt>   the keep-forever part of each pump run's outputs: keep-*.tar.age
//                                 (results, manifests, observations) and catalog-<sha256>.tar.age
//                                 (a tool list, once per distinct catalog; a catalog already copied
//                                 is left out). Every file is age-encrypted already; this job holds
//                                 no key and never decrypts.
//   history-*, registry-*         the history artifacts, public data, as the zips GitHub stores.
//
// Where it goes: the release tagged `keep-forever`, rolled by month (the month
// the artifact was made, UTC):
//   keep-<YYYY-MM>-<id>.tar       one part per run and month, under 2 GiB (a run copies at most
//                                 KEEP_MAX_RUN_BYTES); <id> names the part's contents, so a
//                                 re-run that finds it uploaded does not upload it again
//   manifest-<YYYY-MM>.r<N>.json  what is in that month: every artifact copied, its files and sha256s
//   catalogs.r<N>.json            the sha256 of every catalog copied, for the once-per-catalog rule
//   status.r<N>.json              the last run's result, read by the watchdog (keep/health.mjs)
// The .r<N> files are revisions: a new one is written before the old ones go
// (the newest two stay), so a crash never leaves the release without a manifest.
//
// Idempotent: an artifact the month's manifest lists is skipped without a
// download. The order is part, manifest, catalogs, status; a run that dies
// between the part and the manifest uploads that part again under the same
// name next time, so nothing is lost and nothing is copied twice, unless more
// artifacts arrived in between, when their files may appear in a second part.
//
// Environment: GITHUB_TOKEN (actions: read, contents: write), GITHUB_REPOSITORY,
// GITHUB_API_URL, GITHUB_STEP_SUMMARY, KEEP_MAX_RUN_BYTES.

import { createHash } from 'node:crypto';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ApiBudget } from '../pump/budgets.mjs';
import { createClient, scrub } from '../pump/github.mjs';
import { MAX_LIST_PAGES, download, ingestEntryProblem, kindOf, listArtifacts, prefetchRuns, provenanceProblem } from '../scripts/archive-pull.mjs';
import { readZipLenient } from '../scripts/lib/unzip.mjs';
import { createReleaseClient } from '../snapshot/github.mjs';
import { writeTar } from '../worker-kit/tar.mjs';

export const TAG = 'keep-forever';
export const DEFAULT_MAX_RUN_BYTES = 512 * 1024 ** 2;
export const MAX_RUN_MS = 25 * 60_000;
/** GitHub refuses a release asset of 2 GiB or more. */
export const ASSET_LIMIT = 2 * 1024 ** 3;
const KEEP_NAME = /^ingest-keep-\d+-\d+$/;
const KEEP_FILE = /^(keep-[A-Za-z0-9][A-Za-z0-9._-]{0,200}|catalog-([0-9a-f]{64}))\.tar\.age$/;
const KEEP_REVISIONS = 2;
const USER_AGENT = 'isokron-tool-qa-keep-forever';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const month = (iso) => new Date(iso).toISOString().slice(0, 7);

/** Whether an artifact belongs to the keep-forever set. */
export const wanted = (artifact) => KEEP_NAME.test(artifact.name) || kindOf(artifact.name) === 'history';

/** The newest revision of `<base>.r<N>.json` among the assets: { rev, asset } or null. */
export function newestRevision(assets, base) {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.r(\\d+)\\.json$`);
  let best = null;
  for (const a of assets) {
    const m = re.exec(a.name);
    if (m && (!best || Number(m[1]) > best.rev)) best = { rev: Number(m[1]), asset: a };
  }
  return best;
}

async function readJson(release, assets, base) {
  const r = newestRevision(assets, base);
  if (!r) return { rev: 0, data: null };
  return { rev: r.rev, data: JSON.parse((await release.download(r.asset)).toString('utf8')) };
}

async function writeRevision(release, rel, assets, base, rev, data) {
  const name = `${base}.r${String(rev + 1).padStart(4, '0')}.json`;
  const body = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
  assets.push(await release.upload(rel, name, body));
  // Keep the newest revisions; the oldest go after the new one is in.
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.r(\\d+)\\.json$`);
  const old = assets.filter((a) => re.test(a.name)).sort((a, b) => Number(re.exec(b.name)[1]) - Number(re.exec(a.name)[1])).slice(KEEP_REVISIONS);
  for (const a of old) {
    await release.deleteAsset(a.id);
    assets.splice(assets.indexOf(a), 1);
  }
}

/** The part's content id: the first 12 hex of the sha256 over its sorted "path sha256" lines. */
export const partId = (files) => sha256(files.map((f) => `${f.path}\t${f.sha256}`).sort().join('\n')).slice(0, 12);

/**
 * One run. `gh` is { client (pump/github.mjs), fetch, sleep }; `release` is
 * snapshot/github.mjs createReleaseClient(). Returns the status object that
 * is also uploaded as status.r<N>.json.
 */
export async function runKeepCopy({ gh, release, repo, now = Date.now, log = () => {}, maxRunBytes = DEFAULT_MAX_RUN_BYTES, maxRunMs = MAX_RUN_MS }) {
  const startedAt = new Date(now()).toISOString();
  const deadline = now() + maxRunMs;
  const out = {
    version: 1,
    at: startedAt,
    status: 'ok',
    reason: null,
    last_ok_at: null,
    copied: { artifacts: 0, files: 0, bytes: 0, parts: 0 },
    already: 0,
    skipped_catalogs: 0,
    foreign: [],
    failures: [],
    pending: { count: 0, oldest_at: null },
    deferred: false,
  };
  let rel = await release.getRelease(TAG);
  if (!rel) {
    rel = await release.createRelease({ tag: TAG, name: 'Keep-forever copy', body: 'The keep-forever set, rolled by month. Encrypted parts: see docs/OPERATIONS.md, "Data retention".' });
  }
  const assets = await release.listAssets(rel);
  const prev = await readJson(release, assets, 'status').catch(() => ({ rev: 0, data: null }));
  out.last_ok_at = prev.data?.last_ok_at ?? null;
  const cat = await readJson(release, assets, 'catalogs');
  const catalogs = new Set(Array.isArray(cat.data?.catalogs) ? cat.data.catalogs : []);
  const manifests = new Map(); // month -> { rev, data }
  const manifestFor = async (m) => {
    if (!manifests.has(m)) {
      const r = await readJson(release, assets, `manifest-${m}`);
      manifests.set(m, { rev: r.rev, data: r.data ?? { version: 1, month: m, artifacts: {} }, added: false });
    }
    return manifests.get(m);
  };

  const listing = await listArtifacts(gh.client, repo, null, MAX_LIST_PAGES);
  if (!listing.complete) out.failures.push({ name: 'artifact list', error: `the list did not end within ${MAX_LIST_PAGES} pages` });
  const seen = new Set();
  const list = listing.items
    .filter((a) => !a.expired && wanted(a) && !seen.has(Number(a.id)) && seen.add(Number(a.id)))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
  const runs = new Map();
  await prefetchRuns(gh.client, repo, list, runs);

  const staged = new Map(); // month -> { files: [{path, data, sha256}], artifacts: {name: entry} }
  const newCatalogs = new Set();
  const pending = [];
  let runBytes = 0;
  for (const a of list) {
    const m = month(a.created_at);
    const man = await manifestFor(m);
    if (man.data.artifacts[a.name] || staged.get(m)?.artifacts[a.name]) {
      out.already += 1;
      continue;
    }
    if (runBytes >= maxRunBytes || now() >= deadline) {
      out.deferred = true;
      pending.push(a);
      continue;
    }
    try {
      const origin = await provenanceProblem(gh.client, repo, a, runs);
      if (origin?.ours) throw new Error(`held, not copied: ${origin.why}; add the workflow to SOURCES in scripts/archive-pull.mjs`);
      if (origin) {
        out.foreign.push({ name: a.name, id: a.id, why: origin.why });
        log(`keep: ${a.name}: REFUSED, not from our own workflow on main: ${origin.why}`);
        continue;
      }
      const data = await download(gh.client, gh.fetch, repo, a, gh.sleep);
      const digest = /^sha256:([0-9a-f]{64})$/.exec(String(a.digest ?? ''))?.[1] ?? null;
      if (digest && digest !== sha256(data)) throw new Error('the download does not match the artifact digest; tried again next run');
      if (!digest && Number.isFinite(Number(a.size_in_bytes)) && Number(a.size_in_bytes) !== data.length) throw new Error('the download is not the artifact size, and there is no digest to check; tried again next run');
      runBytes += data.length;
      const files = [];
      const entry = { id: a.id, created_at: a.created_at, digest: digest ?? null, kind: KEEP_NAME.test(a.name) ? 'ingest-keep' : 'history', files: [], refused: [] };
      if (entry.kind === 'history') {
        files.push({ path: `history/${a.name}.zip`, data, sha256: sha256(data) });
      } else {
        const { entries, refused } = readZipLenient(data);
        for (const r of refused) entry.refused.push(`${r.name}: ${r.reason}`);
        for (const e of entries) {
          const why = ingestEntryProblem(e) ?? (KEEP_FILE.test(e.name.split('/').at(-1)) ? null : 'not a keep-* or catalog-* file');
          if (why) {
            entry.refused.push(`${e.name}: ${why}`);
            continue;
          }
          const c = KEEP_FILE.exec(e.name.split('/').at(-1))[2];
          if (c) {
            if (catalogs.has(c) || newCatalogs.has(c)) {
              out.skipped_catalogs += 1;
              continue;
            }
            newCatalogs.add(c);
          }
          files.push({ path: `ingest-keep/${a.name}/${e.name}`, data: e.data, sha256: sha256(e.data) });
        }
      }
      entry.files = files.map((f) => ({ path: f.path, bytes: f.data.length, sha256: f.sha256 }));
      if (!staged.has(m)) staged.set(m, { files: [], artifacts: {} });
      const s = staged.get(m);
      s.files.push(...files);
      s.artifacts[a.name] = entry;
      if (entry.refused.length) log(`keep: ${a.name}: copied, with files refused: ${entry.refused.slice(0, 3).join('; ')}`);
    } catch (err) {
      out.failures.push({ name: a.name, error: scrub(String(err?.message ?? err), []).slice(0, 200) });
      pending.push(a);
      log(`keep: ${a.name}: ${err?.message ?? err}`);
    }
  }

  // Parts first, then the manifests that name them, then the indexes.
  for (const [m, s] of [...staged].sort(([a], [b]) => a.localeCompare(b))) {
    if (s.files.length === 0 && Object.keys(s.artifacts).length === 0) continue;
    try {
      let partName = null;
      if (s.files.length) {
        const tar = writeTar(s.files.map((f) => ({ path: f.path, data: f.data })));
        if (tar.length >= ASSET_LIMIT) throw new Error(`the part is ${tar.length} bytes, past the 2 GiB asset limit`);
        partName = `keep-${m}-${partId(s.files)}.tar`;
        if (!assets.some((a) => a.name === partName)) {
          const up = await release.upload(rel, partName, tar);
          if (Number(up?.size) !== tar.length) throw new Error(`${partName}: GitHub stored ${up?.size} bytes, not ${tar.length}`);
          assets.push(up);
        }
        out.copied.parts += 1;
        out.copied.bytes += tar.length;
      }
      const man = await manifestFor(m);
      for (const [name, entry] of Object.entries(s.artifacts)) man.data.artifacts[name] = { ...entry, part: entry.files.length ? partName : null };
      man.data.updated = startedAt;
      await writeRevision(release, rel, assets, `manifest-${m}`, man.rev, man.data);
      man.rev += 1;
      out.copied.artifacts += Object.keys(s.artifacts).length;
      out.copied.files += s.files.length;
    } catch (err) {
      out.failures.push({ name: `month ${m}`, error: scrub(String(err?.message ?? err), []).slice(0, 200) });
      for (const name of Object.keys(s.artifacts)) pending.push(list.find((a) => a.name === name));
      for (const f of s.files) {
        const c = /^ingest-keep\/[^/]+\/catalog-([0-9a-f]{64})\.tar\.age$/.exec(f.path)?.[1];
        if (c) newCatalogs.delete(c);
      }
    }
  }
  if (newCatalogs.size) {
    try {
      await writeRevision(release, rel, assets, 'catalogs', cat.rev, { version: 1, updated: startedAt, catalogs: [...catalogs, ...newCatalogs].sort() });
    } catch (err) {
      out.failures.push({ name: 'catalogs', error: scrub(String(err?.message ?? err), []).slice(0, 200) });
    }
  }

  const left = pending.filter(Boolean);
  out.pending = { count: left.length, oldest_at: left.map((a) => a.created_at).sort()[0] ?? null };
  if (out.failures.length) {
    out.status = 'error';
    out.reason = `${out.failures.length} item(s) could not be copied: ${out.failures.slice(0, 2).map((f) => `${f.name}: ${f.error}`).join('; ')}`.slice(0, 300);
  } else {
    out.last_ok_at = startedAt;
  }
  try {
    await writeRevision(release, rel, assets, 'status', prev.rev, out);
  } catch (err) {
    out.status = 'error';
    out.reason = `could not write the status: ${String(err?.message ?? err).slice(0, 200)}`;
  }
  return out;
}

export function summary(s) {
  return [
    `**Keep-forever copy: ${s.status}**`,
    '',
    s.reason ? `- ${s.reason}` : null,
    `- copied ${s.copied.artifacts} artifact(s), ${s.copied.files} file(s), ${s.copied.bytes} bytes in ${s.copied.parts} part(s); ${s.already} already there; ${s.skipped_catalogs} catalog(s) already copied`,
    `- still to copy: ${s.pending.count}${s.pending.oldest_at ? ` (oldest ${s.pending.oldest_at})` : ''}${s.deferred ? '; the run stopped early on its byte or time limit' : ''}`,
    s.foreign.length ? `- ${s.foreign.length} artifact(s) not from our own workflow on main were left alone` : null,
    '',
  ].filter((l) => l !== null).join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  if (argv.length) {
    process.stderr.write(`keep: unknown argument ${JSON.stringify(argv[0])}\n`);
    return 2;
  }
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repo || !repo.includes('/') || !token) {
    process.stderr.write('keep: GITHUB_REPOSITORY and GITHUB_TOKEN are required\n');
    return 2;
  }
  const say = (line) => process.stderr.write(`${scrub(line, [token])}\n`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raw = String(env.KEEP_MAX_RUN_BYTES ?? '').trim();
  const maxRunBytes = /^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) < ASSET_LIMIT / 2 ? Number(raw) : DEFAULT_MAX_RUN_BYTES;
  try {
    const budget = new ApiBudget({ sleep, families: { artifacts: { perHour: 600, perMinute: 60 }, actions: { perHour: 200, perMinute: 30 } }, totalPerHour: 800, maxWaitMs: 120_000 });
    const gh = deps.gh ?? { client: createClient({ token, budget, sleep, userAgent: USER_AGENT, ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}) }), fetch: globalThis.fetch, sleep };
    const release = deps.release ?? createReleaseClient({ repo, token, sleep, log: say, ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}) });
    const s = await runKeepCopy({ gh, release, repo, now: deps.now, log: say, maxRunBytes });
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary(s));
    say(`keep: ${s.status}${s.reason ? `: ${s.reason}` : ''}`);
    if (env.GITHUB_ACTIONS === 'true' && s.status !== 'ok') process.stdout.write(`::error title=Keep-forever copy ${s.status}::${String(s.reason ?? '').replace(/[\r\n]+/g, ' ')}\n`);
    return s.status === 'ok' ? 0 : 1;
  } catch (err) {
    say(`keep: ${err?.message ?? err}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
