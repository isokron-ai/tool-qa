// The metadata lanes (meta-github, meta-registry) and release-diff behind one
// interface, so run.mjs and the controls treat them alike:
//
//   lane.collect({ http, repos, token, budget, deadline, log, seed })
//     -> Map<repo, { records, skips, stages, sha }>   (only repos it started)
//   lane.facts(output)   the facts the known-answer control compares

import * as gh from './github.mjs';
import * as reg from './registry.mjs';
import * as rd from './release-diff.mjs';
import { mapLimit } from './lib/http.mjs';

const GITHUB = {
  name: gh.LANE,
  version: gh.VERSION,
  settings: gh.SETTINGS,
  needsToken: true,
  /** A passing problem (rate limit, outage) in a stage the known-answer facts come from, or null. */
  factProblem(output) {
    return output.skips.find((sk) => sk.retryable === true && ['graphql', 'contributors'].includes(sk.stage))?.reason ?? null;
  },
  minIntervalMs: {},
  async collect({ http, repos, token, budget = gh.createBudget(), deadline = () => false, log = () => {}, now = () => new Date() }) {
    const raw = await gh.collect({ http, repos, token, budget, deadline, log });
    const out = new Map();
    for (const [repo, entry] of raw) {
      let o;
      try {
        o = gh.subjectOutput({ ...entry, observedAt: now().toISOString() });
      } catch {
        o = gh.subjectErrorOutput('map');
      }
      out.set(repo, o);
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
  /**
   * A passing problem in what the known-answer facts come from: the read of the
   * subject's own registry entry, or one of the expected npm packages. Other
   * packages, and searches others can crowd, do not count (R-META-07).
   */
  factProblem(output, want) {
    const reg = output.skips.find((sk) => sk.retryable === true && sk.stage === 'mcp_registry');
    if (reg) return reg.reason;
    const mine = new Set((want?.contains?.npm ?? []).map((x) => x.package));
    const hit = (output.stages.npm_packages ?? []).find((x) => mine.has(x.package) && ['rate_limited', 'upstream_unavailable'].includes(x.status));
    return hit ? hit.status : null;
  },
  minIntervalMs: reg.MIN_INTERVAL_MS,
  async collect({ http, repos, deadline = () => false, log = () => {}, seed = new Map(), now = () => new Date(), concurrency = 4 }) {
    const out = new Map();
    await mapLimit(repos, concurrency, async (repo, i) => {
      if (deadline()) return;
      let o;
      try {
        const c = await reg.collectSubject(http, repo, { seed });
        o = reg.subjectOutput(c, now().toISOString());
      } catch (err) {
        // One subject's data never fails the shard (R-META-01).
        log(`subject ${i}: failed (${err?.name ?? 'Error'}); recorded as its own skip`);
        o = reg.subjectErrorOutput();
      }
      out.set(repo, { ...o, sha: null });
      log(`subject ${i}: ${Object.entries(o.stages).filter(([, s]) => typeof s === 'string').map(([k, s]) => `${k}=${s}`).join(' ')}`);
    });
    return out;
  },
  facts(output) {
    const recs = output.records;
    // Only entries in the subject owner's own namespace: anyone can publish an entry that claims the repository (R-META-07).
    const entries = (recs.find((r) => r.field === 'registry_entry_history')?.value ?? []).filter((e) => e.namespace_matches_subject === true);
    const first = entries.map((e) => ({ entity: `mcp-registry:${e.server_name}`, first: e.versions[0] ?? null }));
    const npm = recs.filter((r) => r.field === 'npm_version_doc' && r.value).map((r) => r.value);
    return {
      registry_first: first.map((f) => ({ entity: f.entity, version: f.first?.version ?? null, published_at: f.first?.published_at ?? null }))
        .sort((a, b) => a.entity.localeCompare(b.entity)),
      npm: npm.map((n) => ({ package: n.package, created_at: n.created_at, repository_matches_subject: n.repository_matches_subject }))
        .sort((a, b) => String(a.package).localeCompare(String(b.package))),
      mcp_registry_stage: output.stages.mcp_registry ?? null,
    };
  },
};

const RELEASE_DIFF = {
  name: rd.LANE,
  version: rd.VERSION,
  settings: rd.SETTINGS,
  needsToken: false,
  /** Any passing problem stops the known answer: every fact depends on every read. */
  factProblem(output) {
    return output.skips.find((sk) => sk.retryable === true)?.reason ?? null;
  },
  minIntervalMs: {},
  // Skips run.mjs records for this lane, in the fault-side vocabulary (worker-kit/contract.mjs SKIP_FAULTS):
  // a subject we cannot read (not a GitHub repository) and the shard deadline are our own limits.
  runSkips: Object.freeze({
    notGithub: { stage: 'collect', reason: 'unsupported_layout', fault: 'tool' },
    deadline: { stage: 'collect', reason: 'upstream_unavailable', fault: 'tool', retryable: true },
  }),
  async collect({ http, repos, deadline = () => false, log = () => {}, seed = new Map(), pins = {}, concurrency = 2, clock = () => Date.now() }) {
    const out = new Map();
    await mapLimit(repos, concurrency, async (repo, i) => {
      if (deadline()) return;
      const t0 = clock();
      let o;
      try {
        o = rd.subjectOutput(await rd.collectSubject(http, repo, { seed, pins }));
      } catch (err) {
        // One subject's data never fails the shard; a throw here is our own failure (tool_error).
        log(`subject ${i}: failed (${err?.name ?? 'Error'}); recorded as its own skip`);
        o = rd.subjectErrorOutput();
      }
      o.stages.ms = Math.max(0, clock() - t0);
      out.set(repo, { ...o, sha: null });
      log(`subject ${i}: ${Object.entries(o.stages).map(([k, s]) => `${k}=${s}`).join(' ')}`);
    });
    return out;
  },
  facts(output) {
    const v = (f) => output.records.find((r) => r.field === f)?.value ?? [];
    const arts = v('release_artifacts') ?? [];
    const sums = v('release_diff_summary') ?? [];
    const fnd = v('release_diff_findings') ?? [];
    const held = v('release_diff_held') ?? [];
    const same = (x, a) => x.package === a.package && x.version === a.version && x.artifact === a.artifact;
    return {
      discovered: [...new Set(arts.map((a) => `${a.ecosystem}:${a.package}`))].sort(),
      artifacts: arts.map((a) => {
        const s = sums.find((x) => same(x, a));
        return {
          key: `${a.ecosystem}:${a.package}@${a.version}:${a.artifact}`,
          outcome: a.outcome,
          linked_by: a.linked_by ?? null,
          provenance_verified: a.provenance?.verified ?? null,
          provenance_commit: a.provenance?.commit ?? null,
          tag: a.tag?.name ?? null,
          tag_match: a.tag?.match ?? null,
          tag_commit: a.tag?.commit ?? null,
          basis: a.basis?.kind ?? null,
          files: s?.files ?? null,
          identical: s?.identical ?? null,
          unexplained: s ? s.unexplained_absent + s.unexplained_differs : null,
          findings: fnd.filter((x) => same(x, a)).map((x) => x.kind).sort(),
          held: held.filter((x) => same(x, a)).length,
        };
      }).sort((x, y) => x.key.localeCompare(y.key)),
    };
  },
  /** Facts of several known-answer subjects as one. */
  mergeFacts(parts) {
    return {
      discovered: parts.flatMap((p) => p.discovered).sort(),
      artifacts: parts.flatMap((p) => p.artifacts).sort((x, y) => x.key.localeCompare(y.key)),
    };
  },
};

export const LANES = Object.freeze({ 'meta-github': GITHUB, 'meta-registry': REGISTRY, 'release-diff': RELEASE_DIFF });

export function laneOf(name) {
  const l = LANES[name];
  if (!l) throw new Error(`unknown lane ${JSON.stringify(name)} (meta-github, meta-registry or release-diff)`);
  return l;
}
