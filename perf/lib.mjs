// Pure helpers for the performance baselines (docs/PERFORMANCE.md): versions,
// medians, the machine calibration, and the verdict of one run against the
// same server's previous release. No I/O here, so every rule is unit-tested.

export const RESULT_SCHEMA = 'tool-qa/perf/1';

/**
 * What this workflow may install. perf/servers.json is code a pull request can change, and the install step runs
 * npm on what it names (and `npm rebuild` runs an install script), so the names are limited here, in code the
 * plan job and the install step both enforce, to our own packages and the one native add-on they need.
 */
export const ALLOWED_PACKAGE = /^(kronicle-lite|sea-lite|@isokron\/[a-z0-9][a-z0-9-]*|@mcp-write-safety\/[a-z0-9][a-z0-9-]*)$/;
export const ALLOWED_REBUILD = Object.freeze(['better-sqlite3']);
export const isAllowedPackage = (name) => typeof name === 'string' && ALLOWED_PACKAGE.test(name);
export const isAllowedRebuild = (name) => typeof name === 'string' && ALLOWED_REBUILD.includes(name);

/**
 * The resolved tree an install produced, from npm's hidden lockfile (node_modules/.package-lock.json): every
 * package with its version and integrity, so a later run can see which transitive dependencies it measured.
 * The tree is NOT pinned: only the server's own version is exact.
 */
export function resolvedTree(lock) {
  const rows = [];
  for (const [path, info] of Object.entries(lock?.packages ?? {})) {
    const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path);
    if (!m || !info?.version) continue;
    rows.push(`${m[1]}@${info.version}${info.integrity ? ` ${info.integrity}` : ''}`);
  }
  rows.sort();
  return rows;
}

/** Limits the verdict uses. Generous on purpose: shared runners are noisy. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  // p95 amber / red: the run's p95 must be above the baseline's (scaled by the
  // calibration) by this factor AND by this many milliseconds.
  p95_amber_factor: 1.5,
  p95_amber_ms: 2,
  p95_red_factor: 2.5,
  p95_red_ms: 5,
  // p50 is reported and goes amber only (a slow median with a fine p95 is rare).
  p50_amber_factor: 1.75,
  p50_amber_ms: 1,
  // Error rate: absolute fractions of calls.
  error_amber: 0.002,
  error_red: 0.02,
  // Successful calls per second, as a fraction of the baseline's.
  throughput_amber_fraction: 0.5,
  throughput_red_fraction: 0.3,
  // The calibration ratio (this runner / the baseline's runner) is only used
  // inside this band; outside it the runner is too different to scale by.
  calibration_band: [0.5, 2],
  // When the repeats of the run itself disagree by more than this (max p95 /
  // min p95) the run is "noisy": it can be amber, never red.
  noisy_spread: 3,
});

/** Parse "1.2.3" or "1.2.3-rc.1" into a comparable form; null when not a version. Whole string: no trimming. */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text ?? ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release is above its own pre-releases
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** -1, 0 or 1. Throws on text that is not a version. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x) throw new Error(`not a version: ${JSON.stringify(a)}`);
  if (!y) throw new Error(`not a version: ${JSON.stringify(b)}`);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return comparePre(x.pre, y.pre);
}

/** The newest version in `versions` that is strictly below `current` (a release is only compared with its own earlier one). */
export function previousVersion(current, versions) {
  let best = null;
  for (const v of versions) {
    if (!parseVersion(v)) continue;
    if (compareVersions(v, current) >= 0) continue;
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const round = (x, d = 3) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * Reduce the repeats of one profile to the numbers that are compared.
 * Each repeat is the Inspector's load summary (--format json, the `result` object).
 */
export function summariseRepeats(repeats) {
  const ok = repeats.filter((r) => r && r.latencyMs);
  const p95s = ok.map((r) => r.latencyMs.p95);
  const spread = p95s.length > 1 && Math.min(...p95s) > 0 ? Math.max(...p95s) / Math.min(...p95s) : 1;
  const requests = repeats.reduce((s, r) => s + (r?.requests ?? 0), 0);
  const failed = repeats.reduce((s, r) => s + ((r?.requests ?? 0) - (r?.ok ?? 0)), 0);
  return {
    repeats: repeats.length,
    requests,
    failed,
    p50_ms: round(median(ok.map((r) => r.latencyMs.p50))),
    p95_ms: round(median(p95s)),
    p99_ms: round(median(ok.map((r) => r.latencyMs.p99))),
    // The error rate of the worst repeat, so one bad repeat is not averaged away.
    error_rate: repeats.length ? round(Math.max(...repeats.map((r) => r?.errorRate ?? 1)), 6) : null,
    ok_per_s: round(median(repeats.map((r) => r?.okThroughput)), 1),
    p95_spread: round(spread, 2),
  };
}

/** Median p50/p95 and the worst error rate per scenario step, over the repeats (raw Inspector summaries). */
export function summariseSteps(repeats) {
  const by = new Map();
  for (const r of repeats) {
    for (const st of r?.steps ?? []) {
      if (!by.has(st.name)) by.set(st.name, []);
      by.get(st.name).push(st);
    }
  }
  const out = {};
  for (const [name, list] of by) {
    out[name] = {
      requests: list.reduce((s, x) => s + (x.requests ?? 0), 0),
      p50_ms: round(median(list.map((x) => x.latencyMs?.p50))),
      p95_ms: round(median(list.map((x) => x.latencyMs?.p95))),
      error_rate: round(Math.max(...list.map((x) => x.errorRate ?? 1)), 6),
    };
  }
  return out;
}

/**
 * Session churn over the repeats. The Inspector prints it as `churn: {opened, failed, connectMs}` next to the
 * usual call latencies (--load-churn); null when no repeat has one.
 */
export function summariseChurn(runs) {
  const ok = runs.filter((c) => c && !c.error && c.churn);
  if (!ok.length) return null;
  return {
    sessions_opened: ok.reduce((s, c) => s + (c.churn.opened ?? 0), 0),
    connect_failed: ok.reduce((s, c) => s + (c.churn.failed ?? 0), 0),
    connect_p50_ms: round(median(ok.map((c) => c.churn.connectMs?.p50))),
    connect_p95_ms: round(median(ok.map((c) => c.churn.connectMs?.p95))),
    call_p95_ms: round(median(ok.map((c) => c.latencyMs?.p95))),
    sessions_per_s: round(median(ok.map((c) => (c.churn.opened ?? 0) / ((c.elapsedMs ?? 1) / 1000))), 1),
  };
}

/** Machine speed: the median time of a fixed CPU job, in ms. Smaller is faster. */
export async function calibrate(crypto, now = () => performance.now()) {
  const buf = Buffer.alloc(1 << 20, 7);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = now();
    for (let k = 0; k < 40; k++) crypto.createHash('sha256').update(buf).digest();
    times.push(now() - t0);
  }
  return round(median(times), 2);
}

const rank = { new: 0, ok: 1, amber: 2, red: 3 };
export const worst = (a, b) => (rank[b] > rank[a] ? b : a);

/**
 * Judge one profile summary against the baseline's summary for the same
 * profile of the previous release.
 * @returns {{status: 'ok'|'amber'|'red', noisy: boolean, notes: string[], scale: number, rows: object}}
 */
export function judgeProfile(cur, base, calibration, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const notes = [];
  let status = 'ok';
  const flag = (level, note) => {
    status = worst(status, level);
    notes.push(`${level}: ${note}`);
  };
  // Scale the baseline to this runner's speed, only when both speeds are known and close enough.
  let scale = 1;
  const { cur: cc, base: bc } = calibration ?? {};
  if (cc > 0 && bc > 0) {
    const ratio = cc / bc;
    const [lo, hi] = t.calibration_band;
    if (ratio >= lo && ratio <= hi) scale = ratio;
    else notes.push(`info: runner speed differs by ${round(ratio, 2)}x from the baseline's runner; raw numbers compared`);
  }
  const noisy = (cur.p95_spread ?? 1) > t.noisy_spread;
  const baseP95 = base.p95_ms * scale;
  const baseP50 = base.p50_ms * scale;
  const rows = {
    p95: { base: round(baseP95, 2), cur: cur.p95_ms },
    p50: { base: round(baseP50, 2), cur: cur.p50_ms },
    error_rate: { base: base.error_rate, cur: cur.error_rate },
    ok_per_s: { base: round(base.ok_per_s / scale, 1), cur: cur.ok_per_s },
  };

  if (cur.p95_ms === null || cur.p95_ms === undefined) {
    flag('red', 'no successful calls: the run produced no latency numbers');
    return { status, noisy, notes, scale, rows };
  }
  if (cur.p95_ms > baseP95 * t.p95_red_factor && cur.p95_ms - baseP95 > t.p95_red_ms) {
    flag('red', `p95 ${cur.p95_ms} ms is more than ${t.p95_red_factor}x and ${t.p95_red_ms} ms above the baseline's ${round(baseP95, 2)} ms`);
  } else if (cur.p95_ms > baseP95 * t.p95_amber_factor && cur.p95_ms - baseP95 > t.p95_amber_ms) {
    flag('amber', `p95 ${cur.p95_ms} ms is more than ${t.p95_amber_factor}x and ${t.p95_amber_ms} ms above the baseline's ${round(baseP95, 2)} ms`);
  }
  if (cur.p50_ms > baseP50 * t.p50_amber_factor && cur.p50_ms - baseP50 > t.p50_amber_ms) {
    flag('amber', `p50 ${cur.p50_ms} ms is more than ${t.p50_amber_factor}x and ${t.p50_amber_ms} ms above the baseline's ${round(baseP50, 2)} ms`);
  }
  const errRise = (cur.error_rate ?? 0) - (base.error_rate ?? 0);
  if (errRise > t.error_red) flag('red', `error rate ${cur.error_rate} is ${round(errRise, 4)} above the baseline's ${base.error_rate}`);
  else if (errRise > t.error_amber) flag('amber', `error rate ${cur.error_rate} is above the baseline's ${base.error_rate}`);
  const floor = (base.ok_per_s / scale) * t.throughput_red_fraction;
  const soft = (base.ok_per_s / scale) * t.throughput_amber_fraction;
  if (cur.ok_per_s < floor) flag('red', `${cur.ok_per_s} ok calls/s is below ${t.throughput_red_fraction} of the baseline's ${round(base.ok_per_s / scale, 1)}`);
  else if (cur.ok_per_s < soft) flag('amber', `${cur.ok_per_s} ok calls/s is below ${t.throughput_amber_fraction} of the baseline's ${round(base.ok_per_s / scale, 1)}`);

  if (noisy && status === 'red') {
    status = 'amber';
    notes.push(`info: the run's own repeats disagree (p95 spread ${cur.p95_spread}x), so red is shown as amber; run it again`);
  }
  return { status, noisy, notes, scale, rows };
}

/**
 * Compare a full result (all profiles) with the baseline of the previous
 * release of the same server. `baseline` is null when there is none.
 */
export function judgeResult(result, baseline, thresholds = DEFAULT_THRESHOLDS) {
  if (!baseline) {
    // Nothing to compare with, but a first baseline must be clean: failed calls or a failed profile are not a baseline.
    const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
    const notes = ['no earlier release has a baseline: this run is the first baseline'];
    let status = 'new';
    for (const [name, cur] of Object.entries(result.profiles)) {
      if (!cur.summary || cur.error) { status = 'red'; notes.push(`profile ${name} did not complete (${cur.error ?? 'no summary'})`); }
      else if ((cur.summary.error_rate ?? 0) > t.error_red) { status = 'red'; notes.push(`profile ${name}: error rate ${cur.summary.error_rate} is too high to be a baseline`); }
    }
    return { status, baseline_version: null, profiles: {}, notes };
  }
  if (baseline.server !== result.server) {
    throw new Error(`refusing to compare different servers: ${result.server} against ${baseline.server}`);
  }
  let status = 'ok';
  const profiles = {};
  const notes = [];
  for (const [name, base] of Object.entries(baseline.profiles ?? {})) {
    if (base?.summary && !Object.hasOwn(result.profiles, name)) {
      status = worst(status, 'amber');
      notes.push(`amber: profile ${name} is in the ${baseline.version} baseline but missing from this result, so it was not compared`);
    }
  }
  for (const [name, cur] of Object.entries(result.profiles)) {
    const base = baseline.profiles?.[name];
    if (!base?.summary) {
      notes.push(`profile ${name}: not in the baseline, nothing to compare`);
      continue;
    }
    if (!cur.summary || cur.error) {
      profiles[name] = { status: 'red', noisy: false, notes: [`red: profile did not complete (${cur.error ?? 'no summary'})`], scale: 1, rows: {} };
      status = worst(status, 'red');
      continue;
    }
    const j = judgeProfile(cur.summary, base.summary, { cur: result.runner?.calibration_ms, base: baseline.runner?.calibration_ms }, thresholds);
    profiles[name] = j;
    status = worst(status, j.status);
  }
  return { status, baseline_version: baseline.version, profiles, notes };
}
