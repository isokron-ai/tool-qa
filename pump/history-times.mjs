// When each history capture last succeeded, for the public live snapshot.
//
// live/build.mjs shows `last_capture_at` for registry-delta (from kv
// pump.registry_delta), registry-full, packages and popularity, but only reads
// the last three from config.history. The pump used to pass an empty list, so
// they showed null. This looks up the newest SUCCESSFUL run of each capture
// through the pump's GitHub client (same budget and retry wrapper, family
// `actions`) and keeps the answer in kv `pump.history_times`, so the lookup is
// at most one round of three reads every 30 minutes, whatever the tick rate.
//
// It never throws: a failed read keeps the cached value for that kind (or null),
// is logged as one line, and the pump goes on.

export const HISTORY_TIMES_KEY = 'pump.history_times';
export const HISTORY_TIMES_REFRESH_MS = 30 * 60_000;
export const HISTORY_TIMES_KINDS = Object.freeze(['registry-full', 'packages', 'popularity']);
export const HISTORY_WORKFLOWS = Object.freeze({
  packages: 'history-packages.yml',
  popularity: 'history-popularity.yml',
  'registry-full': 'history-registry.yml',
});
// registry-full needs a wider page: delta runs (every 15 minutes) share the workflow.
const FULL_PAGE = 50;
// The UTC hour of the daily full capture's cron (history-registry.yml: "17 3 * * *").
export const FULL_CRON_HOUR = 3;
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const timeOf = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * The newest run of history-registry.yml that was the daily FULL capture.
 * The workflow sets run-name "history-registry full" / "... delta", so a title
 * ending in " full" is exact. Runs from before the run-name (or whose title is
 * missing) are told apart by the schedule instead: the daily full capture is
 * cron "17 3 * * *", so a scheduled run created in the 03:xx UTC hour is the
 * full one (the delta cron runs every 15 minutes and its runs are titled "... delta").
 * If this cron changes, update FULL_CRON_HOUR here; test R-LIVE-48 guards it.
 * `runs` come newest first from the API; the newest match wins either way.
 */
export function pickFullRun(runs) {
  let best = null;
  for (const r of Array.isArray(runs) ? runs : []) {
    const title = String(r?.display_title ?? r?.name ?? '');
    const created = timeOf(r?.created_at);
    const byTitle = / full$/.test(title);
    const byCron = r?.event === 'schedule' && created !== null && new Date(created).getUTCHours() === FULL_CRON_HOUR && !/ delta$/.test(title);
    if (!byTitle && !byCron) continue;
    const at = timeOf(r?.updated_at);
    if (at !== null && (best === null || at > best)) best = at;
  }
  return best;
}

/** `[{kind, last_capture_at}]` for config.history, from the kv record. */
export function historyList(record) {
  const kinds = record?.kinds && typeof record.kinds === 'object' ? record.kinds : {};
  return HISTORY_TIMES_KINDS.map((kind) => ({ kind, last_capture_at: kinds[kind]?.last_capture_at ?? null }));
}

/** Is a refresh due (nothing kept, or the kept answer is 30 minutes old)? */
export function historyTimesDue(cached, now, refreshMs = HISTORY_TIMES_REFRESH_MS) {
  const age = now - (timeOf(cached?.at) ?? -Infinity);
  return !(cached && age >= 0 && age < refreshMs);
}

/**
 * @param {{ client: { request: Function }, repo: string, now: number, cached?: object|null,
 *   refreshMs?: number, until?: number, clock?: () => number, log?: (line: string) => void }} args
 * @returns {Promise<{ record: object, called: number, refreshed: boolean, complete: boolean }>}
 *   record: what to keep in kv (the cached one when nothing changed).
 */
export async function refreshHistoryTimes({ client, repo, now, cached = null, refreshMs = HISTORY_TIMES_REFRESH_MS, until = Infinity, clock = () => now, log = () => {} }) {
  const prior = cached && typeof cached === 'object' ? cached : null;
  if (!historyTimesDue(prior, now, refreshMs)) return { record: prior, called: 0, refreshed: false, complete: true };
  const kinds = { ...(prior?.kinds ?? {}) };
  let called = 0;
  let complete = true;
  for (const kind of HISTORY_TIMES_KINDS) {
    if (clock() >= until) { complete = false; break; } // the tick's deadline: keep what we have
    try {
      called += 1;
      const res = await client.request('GET', `/repos/${repo}/actions/workflows/${HISTORY_WORKFLOWS[kind]}/runs`, {
        family: 'actions', allow: [404],
        query: { status: 'success', branch: 'main', per_page: kind === 'registry-full' ? FULL_PAGE : 1, exclude_pull_requests: true },
      });
      const runs = res.data?.workflow_runs ?? [];
      const t = kind === 'registry-full' ? pickFullRun(runs) : timeOf(runs[0]?.updated_at);
      if (t !== null) kinds[kind] = { last_capture_at: isoSeconds(t) };
    } catch (err) {
      complete = false;
      log(`pump: history time for ${kind} not read (keeping ${kinds[kind]?.last_capture_at ?? 'none'}): ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
  // `at` moves only when every read worked: otherwise the next run tries again.
  return { record: { at: complete ? isoSeconds(now) : prior?.at ?? null, kinds }, called, refreshed: true, complete };
}
