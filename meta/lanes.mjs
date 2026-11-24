// The two metadata lanes behind one interface, so run.mjs and the controls
// treat them alike:
//
//   lane.collect({ http, repos, token, budget, deadline, log, seed })
//     -> Map<repo, { records, skips, stages, sha }>   (only repos it started)
//   lane.facts(output)   the facts the known-answer control compares

import * as gh from './github.mjs';
import * as reg from './registry.mjs';
import { mapLimit } from './lib/http.mjs';

const GITHUB = {
  name: gh.LANE,
  version: gh.VERSION,
  settings: gh.SETTINGS,
  needsToken: true,
  minIntervalMs: {},
  async collect({ http, repos, token, budget = gh.createBudget(), deadline = () => false, log = () => {}, now = () => new Date() }) {
    const raw = await gh.collect({ http, repos, token, budget, deadline, log });
    const out = new Map();
    for (const [repo, entry] of raw) {
      out.set(repo, gh.subjectOutput({ ...entry, observedAt: now().toISOString() }));
    }
    return out;
  },
  facts(output) {
    const v = (f) => output.records.find((r) => r.field === f)?.value ?? null;
    const core = v('repo_core');
    return {
      full_name: core?.full_name ?? null,
      github_id: core?.github_id ?? null,
      created_at: core?.created_at ?? null,
      owner_type: core?.owner_type ?? null,
      owner_id: core?.owner_id ?? null,
      fork: core?.fork ?? null,
      licence_spdx: core?.licence?.spdx_id ?? null,
      releases_total: v('releases_summary')?.total ?? null,
      contributors_accounts: v('contributors_counts')?.accounts ?? null,
    };
  },
};

const REGISTRY = {
  name: reg.LANE,
  version: reg.VERSION,
  settings: reg.SETTINGS,
  needsToken: false,
  minIntervalMs: reg.MIN_INTERVAL_MS,
  async collect({ http, repos, deadline = () => false, log = () => {}, seed = new Map(), now = () => new Date(), concurrency = 4 }) {
    const out = new Map();
    await mapLimit(repos, concurrency, async (repo, i) => {
      if (deadline()) return;
      const c = await reg.collectSubject(http, repo, { seed });
      const o = reg.subjectOutput(c, now().toISOString());
      out.set(repo, { ...o, sha: null });
      log(`subject ${i}: ${Object.entries(o.stages).map(([k, s]) => `${k}=${s}`).join(' ')}`);
    });
    return out;
  },
  facts(output) {
    const recs = output.records;
    const entries = recs.find((r) => r.field === 'registry_entry_history')?.value ?? [];
    const first = entries.map((e) => ({ entity: `mcp-registry:${e.server_name}`, first: e.versions[0] ?? null }));
    const npm = recs.filter((r) => r.field === 'npm_version_doc' && r.value).map((r) => r.value);
    return {
      registry_first: first.map((f) => ({ entity: f.entity, version: f.first?.version ?? null, published_at: f.first?.published_at ?? null }))
        .sort((a, b) => a.entity.localeCompare(b.entity)),
      npm: npm.map((n) => ({ package: n.package, created_at: n.created_at, repository_matches_subject: n.repository_matches_subject }))
        .sort((a, b) => String(a.package).localeCompare(String(b.package))),
      mcp_registry_stage: output.stages.mcp_registry ?? null,
      npm_stage: output.stages.npm ?? null,
    };
  },
};

export const LANES = Object.freeze({ 'meta-github': GITHUB, 'meta-registry': REGISTRY });

export function laneOf(name) {
  const l = LANES[name];
  if (!l) throw new Error(`unknown lane ${JSON.stringify(name)} (meta-github or meta-registry)`);
  return l;
}
