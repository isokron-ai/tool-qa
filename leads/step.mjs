// The pump's lead step: once per pump run, after the ticks, it files new lead
// issues, closes and reopens the issues of leads whose status changed, and
// writes the plan to the job summary (leads/plan.mjs for what, state/leads.mjs
// for the rules). The pump is the state's only writer, so this runs inside it.
//
//   off      nothing (kv leads.last says so)
//   dry-run, recheck   the plan goes to the job summary ($GITHUB_STEP_SUMMARY, which
//            is public in a public repository: shapes only); no issue is touched
//   on       the same summary, and the plan is carried out on our repositories with
//            installation tokens of the loop's App, one per repository, narrowed to
//            issues: write (pump/app-token.mjs refuses anything broader)
//
// Filing is crash-safe the way dispatching is (R-ING-10): the leads about to be
// filed are marked (filing_started_at) and the state is saved before any issue
// is created. A lead marked but with no issue number on a later run is looked
// up among the repository's lead issues (label loop-lead, title tag
// `[lead <fingerprint>]`) and adopted when found, else filed again. At most
// maxWrites issue writes per run (LEADS_MAX_WRITES, default 60, never over 100;
// state/leads.mjs capsFrom), inside STEP_BUDGET_MS; the issues API family has
// its own budget (pump/budgets.mjs: spaced, and held on a secondary rate limit).
// A rate-limit refusal (403 or 429) or a spent budget stops the writes of this
// run; the next run goes on.
//
// An issue is filed only once lead-repro has a verdict for its repro, and shows
// a fixture only when that verdict is reproduced (leads/repro-gate.mjs,
// R-LEAD-54, R-LEAD-60): a lead whose check is running, stuck or failed is not
// filed (fail closed); the open issues of ours whose verdict changed are edited.
//
// Never throws: a failure is logged and counted in kv leads.last, and the next
// run tries again.

import { appendFileSync, readFileSync } from 'node:fs';

import { createClient } from '../pump/github.mjs';
import { capsFrom, filesLeads, MAX_WRITES_PER_RUN } from '../state/leads.mjs';
import { issueFor, MARKER, planFilings, renderPlan, titleTag } from './plan.mjs';
import { REPRO_REPO, reproVerdicts } from './repro-gate.mjs';
import { TEMPLATE_VERSION } from './repro.mjs';

export const LEADS_LAST_KEY = 'leads.last';
/** Issue writes (create, close, reopen, comment, edit) per pump run at most, unless LEADS_MAX_WRITES says otherwise. */
export const MAX_WRITES = MAX_WRITES_PER_RUN;
/** The issue writes of one run stop this long after the lead step starts, so the pump's run stays bounded. */
export const STEP_BUDGET_MS = 6 * 60_000;
/** kv: what each open issue of ours was last written with (body format, repro key and verdict), by fingerprint. */
export const BODIES_KEY = 'leads.bodies';
/** Bumped when the issue body's layout changes: every open issue of ours is brought up to it once. */
export const BODY_VERSION = 2;
/** Issue bodies brought up to date per run at most (each one read and one edit). */
export const MAX_REFRESH = 10;
/** kv leads.last keeps a sample of the open queue at most this often, and this many. */
export const HISTORY_EVERY_MS = 3_600_000;
export const HISTORY_MAX = 30;
/** The login GitHub shows for issues our App files (its slug plus [bot]); LEADS_BOT_LOGIN overrides it. */
export const DEFAULT_BOT_LOGIN = 'isokron-tool-qa[bot]';
/** Pages of 100 issues looked through to adopt a filing that was not confirmed. */
export const ADOPT_PAGES = 3;

const repoName = (repo) => String(repo).split('/')[1];

/**
 * @param {object} o
 * @param {import('../state/db.mjs').StateDb} o.db
 * @param {'off'|'dry-run'|'recheck'|'on'} o.mode
 * @param {object} o.tierWeights  pump/tiers.json weights
 * @param {() => number} o.now
 * @param {(line: string) => void} o.log
 * @param {(args: object) => Promise<{token: string}>} [o.mintToken]   the pump's App token minter
 * @param {(why: string) => Promise<boolean>} [o.save]  the pump's state push; false stops the filing
 * @param {string} [o.summaryFile]  $GITHUB_STEP_SUMMARY
 * @param {object} [o.client]  options for pump/github.mjs createClient (fetch, apiUrl, budget, sleep, retryUntil)
 * @returns {Promise<object>} what kv leads.last holds
 */
export async function leadStep({ db, mode, tierWeights, now, log = () => {}, mintToken, save, summaryFile, client: clientOpts = {}, env = process.env, maxWrites, botLogin = process.env.LEADS_BOT_LOGIN || DEFAULT_BOT_LOGIN, workflows = loadWorkflows(), fetch: fetchImpl = clientOpts.fetch ?? globalThis.fetch, stepBudgetMs = STEP_BUDGET_MS, reproGate = reproVerdicts }) {
  const at = () => new Date(now()).toISOString();
  const caps = capsFrom(env);
  const writeCap = Number.isSafeInteger(maxWrites) ? maxWrites : caps.maxWrites;
  const note = { at: at(), mode, filed: 0, closed: 0, reopened: 0, adopted: 0, refiled: 0, refreshed: 0, repro_waiting: 0, errors: 0, writes: 0, caps: { new_per_day: caps.capNew, open: caps.capOpen, writes: writeCap } };
  for (const n of caps.notes) log(`leads: ${n}`);
  const done = new Map();
  const stopAt = now() + stepBudgetMs;
  try {
    if (mode === 'off' || db.schemaVersion() < 12) {
      db.setKv(LEADS_LAST_KEY, { ...note, off: true }, { now: now() });
      return note;
    }
    const capArgs = { capNew: caps.capNew, capOpen: caps.capOpen };
    let plan = planFilings(db, { now: at(), tierWeights, ...capArgs });
    Object.assign(note, counts(db), { planned: plan.file.length, capped: plan.capped.length, held: plan.held.length });
    note.held_by = plan.held.reduce((m, e) => { const r = e.decision?.reason ?? 'held'; m[r] = (m[r] ?? 0) + 1; return m; }, {});

    if (filesLeads(mode) && typeof mintToken === 'function') {
      const ours = (i) => i?.user?.login === botLogin; // anyone may open an issue: only our App's count
      const clients = new Map();
      const clientFor = async (repo) => {
        if (!clients.has(repo)) {
          const { token } = await mintToken({ repositories: [repoName(repo)], permissions: { issues: 'write' } });
          clients.set(repo, createClient({ token, ...clientOpts }));
        }
        return clients.get(repo);
      };
      // A rate-limit refusal or a spent budget stops every write of this run (R-LEAD-56): the next run goes on.
      const stopped = () => note.backed_off === true || now() >= stopAt;
      const backOff = (err) => {
        const status = Number(err?.status);
        if (err?.name === 'BudgetExceededError' || status === 403 || status === 429) {
          if (!note.backed_off) log(`leads: stopping the issue writes of this run (${err?.name === 'BudgetExceededError' ? 'the issues budget is spent' : `HTTP ${status}`}); the next run goes on`);
          note.backed_off = true;
          return true;
        }
        return false;
      };
      const write = async (fn) => {
        if (note.writes >= writeCap || stopped()) return null;
        note.writes += 1;
        return fn();
      };
      // 1. Filings started on an earlier run and not confirmed: adopt the issue if it was made, else file again.
      for (const e of plan.indoubt) {
        try {
          const gh = await clientFor(e.lead.repo);
          // Newest first, a few pages, label or not (R-LEAD-30): our App's issue with this lead's title tag and marker (R-LEAD-41).
          let hit = null;
          for (let page = 1; page <= ADOPT_PAGES && !hit; page++) {
            const res = await gh.request('GET', `/repos/${e.lead.repo}/issues`, { query: { state: 'all', per_page: 100, page, sort: 'created', direction: 'desc' } });
            const list = Array.isArray(res.data) ? res.data : [];
            hit = list.find((i) => !i?.pull_request && ours(i) && typeof i?.title === 'string' && i.title.startsWith(titleTag(e.lead.fingerprint))
              && typeof i?.body === 'string' && i.body.includes(MARKER(e.lead.fingerprint))) ?? null;
            if (list.length < 100) break;
          }
          if (hit) {
            db.tx(() => db.raw.prepare("UPDATE leads SET status = 'filed', issue_number = ?, issue_state = ?, filed_at = COALESCE(filed_at, ?), filing_started_at = NULL, updated_at = ? WHERE fingerprint = ?")
              .run(hit.number, hit.state === 'closed' ? 'closed' : 'open', at(), at(), e.lead.fingerprint));
            note.adopted += 1;
            done.set(e.lead.fingerprint, `adopted #${hit.number}`);
          } else {
            db.tx(() => db.raw.prepare('UPDATE leads SET filing_started_at = NULL, updated_at = ? WHERE fingerprint = ?').run(at(), e.lead.fingerprint));
            note.refiled += 1;
          }
        } catch (err) {
          note.errors += 1;
          backOff(err);
          log(`leads: could not confirm the filing of ${e.lead.fingerprint} on ${e.lead.repo}: ${err?.message ?? err}`);
        }
      }
      if (plan.indoubt.length) plan = planFilings(db, { now: at(), tierWeights, ...capArgs });

      // 2. Issues whose lead closed (3 clean re-checks) or came back.
      for (const [list, state, verb] of [[plan.close, 'closed', 'closed'], [plan.reopen, 'open', 'reopened']]) {
        for (const e of list) {
          if (stopped()) break;
          try {
            const gh = await clientFor(e.lead.repo);
            const text = state === 'closed'
              ? `The loop re-checked this ${e.lead.clean_rechecks} times without seeing it, and no server carries it now: closing. It reopens if it comes back.`
              : `It came back (${e.lead.sightings} sightings in all, last ${e.lead.last_seen.slice(0, 10)}): reopening.`;
            // Read it first (R-LEAD-43): an issue a person closed or reopened, or one our App did not open, is left alone.
            const cur = (await gh.request('GET', `/repos/${e.lead.repo}/issues/${e.lead.issue_number}`)).data ?? {};
            const synced = (s2, why) => {
              db.tx(() => db.raw.prepare('UPDATE leads SET issue_state = ?, needs_sync = 0, updated_at = ? WHERE fingerprint = ?').run(s2, at(), e.lead.fingerprint));
              if (why) log(`leads: issue #${e.lead.issue_number} on ${e.lead.repo} left as it is: ${why}`);
            };
            if (!ours(cur)) { synced(e.lead.issue_state, 'not opened by our App'); continue; }
            if (cur.state === state) { synced(state, null); continue; }
            if (cur.state !== e.lead.issue_state) { synced(cur.state === 'closed' ? 'closed' : 'open', `its state was changed by hand (${cur.state})`); continue; }
            // A person's "not planned" close stands: the lead coming back does not reopen it (R-LEAD-46).
            if (state === 'open' && cur.state_reason === 'not_planned') { synced('closed', 'closed as not planned by a person'); continue; }
            // Both writes (state, then the comment) count against the cap, and go only together (R-LEAD-44).
            if (note.writes + 2 > writeCap) break;
            note.writes += 2;
            // The state first: a failed comment never makes the next run comment again.
            await gh.request('PATCH', `/repos/${e.lead.repo}/issues/${e.lead.issue_number}`, { body: { state, ...(state === 'closed' ? { state_reason: 'completed' } : {}) } });
            synced(state, null);
            try {
              await gh.request('POST', `/repos/${e.lead.repo}/issues/${e.lead.issue_number}/comments`, { body: { body: text } });
            } catch (err) {
              log(`leads: issue #${e.lead.issue_number} on ${e.lead.repo} is ${state}, but its comment failed: ${err?.message ?? err}`);
            }
            note[verb] += 1;
            done.set(e.lead.fingerprint, `${verb} #${e.lead.issue_number}`);
          } catch (err) {
            note.errors += 1;
            backOff(err);
            log(`leads: could not set issue #${e.lead.issue_number} on ${e.lead.repo} ${state}: ${err?.message ?? err}`);
          }
        }
      }

      // The repro verdicts of the leads to file and of the open issues of ours (R-LEAD-54): read back, or asked for.
      // A token for tool-qa with actions: write (read the artifacts, dispatch lead-repro), minted only when needed.
      const getClient = async () => createClient({ token: (await mintToken({ repositories: [repoName(REPRO_REPO)], permissions: { actions: 'write' } })).token, ...clientOpts });
      const refresh = plan.refresh.filter((e) => e.lead.repo && Number.isSafeInteger(e.lead.issue_number));
      let verdicts = new Map();
      try {
        verdicts = await reproGate({ db, leads: [...plan.file, ...refresh].map((e) => e.lead), workflows, now: now(), getClient, fetch: fetchImpl, log, note });
      } catch (err) {
        note.errors += 1;
        note.repro_stuck = (note.repro_stuck ?? 0) + 1;
        log(`leads: the lead-repro check failed (nothing waiting for it is filed this run): ${err?.message ?? err}`);
        verdicts = new Map([...plan.file, ...refresh].map((e) => [e.lead.fingerprint, { state: 'pending', key: null, verdict: null }]));
      }
      const reproOf = (e) => verdicts.get(e.lead.fingerprint) ?? null;
      const runnerOf = (e) => workflows?.[e.lead.lane]?.recheck_runner ?? null;

      // 2b. Open issues of ours whose repro verdict (or body layout) changed since they were written: edited by our App.
      const bodies = (() => { try { const v = db.getKv(BODIES_KEY); return v && typeof v === 'object' ? v : {}; } catch { return {}; } })();
      const stamp = (r) => `${BODY_VERSION}:${TEMPLATE_VERSION}:${r?.key ?? '-'}:${r?.state === 'ready' ? r.verdict?.verdict : r?.state ?? '-'}`;
      let refreshed = 0;
      for (const e of refresh) {
        if (refreshed >= MAX_REFRESH || stopped()) break;
        const r = reproOf(e);
        if (r?.state !== 'ready') continue;
        const want = stamp(r);
        if (bodies[e.lead.fingerprint] === want) continue;
        try {
          const gh = await clientFor(e.lead.repo);
          const cur = (await gh.request('GET', `/repos/${e.lead.repo}/issues/${e.lead.issue_number}`)).data ?? {};
          // Only an open issue our App opened, with this lead's marker: anything else is left alone.
          if (!ours(cur) || cur.state !== 'open' || typeof cur.body !== 'string' || !cur.body.includes(MARKER(e.lead.fingerprint))) { bodies[e.lead.fingerprint] = want; continue; }
          const body = issueFor(e, { now: at(), repro: r, recheckRunner: runnerOf(e) }).body;
          if (cur.body !== body) {
            const res = await write(() => gh.request('PATCH', `/repos/${e.lead.repo}/issues/${e.lead.issue_number}`, { body: { body } }));
            if (!res) break;
            refreshed += 1;
            note.refreshed += 1;
            done.set(e.lead.fingerprint, `edited #${e.lead.issue_number}`);
          }
          bodies[e.lead.fingerprint] = want;
        } catch (err) {
          note.errors += 1;
          if (backOff(err)) break;
          log(`leads: could not bring issue #${e.lead.issue_number} on ${e.lead.repo} up to date: ${err?.message ?? err}`);
        }
      }

      // 3. New issues, within the caps: marked and saved first, then created. A lead whose repro check is still
      // running waits for it (it keeps its place; nothing is marked).
      const issues = [];
      for (const e of plan.file) {
        if (issues.length + note.writes >= writeCap) break;
        const r = reproOf(e);
        // Fail closed: only a lead whose repro verdict is in is filed; waiting, stuck or no answer at all is not (R-LEAD-60).
        if (r?.state !== 'ready') { note.repro_waiting += 1; done.set(e.lead.fingerprint, r?.state === 'stuck' ? 'lead-repro stuck: not filed' : 'waiting for lead-repro'); continue; }
        // Held leads never get here: planFilings runs the shape guard before handing out room (R-LEAD-42).
        const issue = issueFor(e, { now: at(), repro: r, recheckRunner: runnerOf(e) });
        issues.push({ e, issue, stamp: stamp(r) });
      }
      if (issues.length) {
        db.tx(() => {
          for (const { e } of issues) db.raw.prepare('UPDATE leads SET filing_started_at = ?, updated_at = ? WHERE fingerprint = ?').run(at(), at(), e.lead.fingerprint);
        });
        const saved = typeof save === 'function' ? await save('leads, before filing') : true;
        if (!saved) {
          log('leads: the state could not be saved before filing; nothing filed this run (the marks are looked up next run)');
        } else {
          for (const { e, issue, stamp: st } of issues) {
            if (stopped()) break;
            try {
              const gh = await clientFor(e.lead.repo);
              const res = await write(async () => {
                try {
                  return await gh.request('POST', `/repos/${e.lead.repo}/issues`, { body: issue });
                } catch (err) {
                  // A repository that refuses the label (no permission to create it): file without it. Adoption finds
                  // such an issue by its title tag, so it is never filed twice either.
                  if (Number(err?.status) !== 422) throw err;
                  // The retry is a write of its own (R-LEAD-44): over the cap, the lead stays marked and is looked up next run.
                  return write(() => gh.request('POST', `/repos/${e.lead.repo}/issues`, { body: { title: issue.title, body: issue.body } }));
                }
              });
              if (!res) break;
              const number = Number(res.data?.number);
              if (!Number.isSafeInteger(number)) throw new Error('no issue number in the answer');
              db.tx(() => db.raw.prepare("UPDATE leads SET status = 'filed', issue_number = ?, issue_state = 'open', filed_at = ?, filing_started_at = NULL, updated_at = ? WHERE fingerprint = ?")
                .run(number, at(), at(), e.lead.fingerprint));
              note.filed += 1;
              bodies[e.lead.fingerprint] = st;
              done.set(e.lead.fingerprint, `filed #${number}`);
            } catch (err) {
              note.errors += 1;
              log(`leads: could not file ${e.lead.fingerprint} on ${e.lead.repo}: ${err?.message ?? err}`);
              if (backOff(err)) break;
            }
          }
        }
      }
      try {
        // Only the fingerprints of open issues of ours are kept.
        const keep = new Set(db.listLeads().filter((l) => l.issue_number != null).map((l) => l.fingerprint));
        db.setKv(BODIES_KEY, Object.fromEntries(Object.entries(bodies).filter(([fp]) => keep.has(fp))), { now: now() });
      } catch (err) {
        log(`leads: could not keep what the issues were written with: ${err?.message ?? err}`);
      }
      Object.assign(note, counts(db));
    }
    if (summaryFile) {
      try {
        appendFileSync(summaryFile, renderPlan(plan, { now: at(), mode, done }));
      } catch (err) {
        log(`leads: could not write the job summary: ${err?.message ?? err}`);
      }
    }
  } catch (err) {
    note.errors += 1;
    log(`leads: the lead step failed (continuing): ${err?.message ?? err}`);
  }
  try {
    // The open queue over time, for the watchdog's growth check (watchdog/leads.mjs): a sample an hour at most, the last 30.
    const prev = db.getKv(LEADS_LAST_KEY);
    const hist = Array.isArray(prev?.history) ? prev.history.filter((h) => Array.isArray(h) && Number.isFinite(Date.parse(h[0]))) : [];
    if (!note.off && Number.isFinite(note.open) && (hist.length === 0 || Date.parse(note.at) - Date.parse(hist.at(-1)[0]) >= HISTORY_EVERY_MS)) hist.push([note.at, note.open]);
    note.history = hist.slice(-HISTORY_MAX);
    db.setKv(LEADS_LAST_KEY, note, { now: now() });
  } catch { /* the note is only for the watchdog */ }
  // One status line every run the pipeline is on, so the pump log shows it ran even when there was nothing to file
  // (R-LEAD-49). Counts and our reason codes only: no subject, no run id.
  if (!note.off && mode !== 'off') {
    const held = Object.entries(note.held_by ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
    const rc = (() => { try { return db.getKv('leads.recheck'); } catch { return null; } })();
    log(`leads: ${mode}: ${note.open ?? 0} open, ${note.filed_total ?? 0} filed, ${note.closed_total ?? 0} closed; this run: ${note.planned ?? 0} to file, `
      + `${note.capped ?? 0} over the caps, ${note.held ?? 0} held${held ? ` (${held})` : ''}; filed ${note.filed}, closed ${note.closed}, reopened ${note.reopened}, `
      + `adopted ${note.adopted}, edited ${note.refreshed}, not filed for lead-repro ${note.repro_waiting} (waiting ${note.repro_pending ?? 0}, stuck ${note.repro_stuck ?? 0}, dispatch errors ${note.repro_dispatch_errors ?? 0}${note.repro_no_token ? ', no token' : ''}), `
      + `errors ${note.errors}, writes ${note.writes}/${note.caps.writes}${note.backed_off ? ' (backed off)' : ''}`
      + `${rc ? `; re-checks due ${rc.due ?? 0}, waiting ${rc.waiting ?? 0}, given up ${rc.given_up ?? 0}` : ''}`);
  }
  return note;
}

/** pump/workflows.json's workflows (the lanes' pins and re-check runners), or {} when it cannot be read. */
export function loadWorkflows(file = new URL('../pump/workflows.json', import.meta.url)) {
  try { return JSON.parse(readFileSync(file, 'utf8')).workflows ?? {}; } catch { return {}; }
}

/** Lead counts by status, and the open ones nobody has filed (the queue). */
function counts(db) {
  const rows = db.raw.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status').all();
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return { open: by.open ?? 0, filed_total: by.filed ?? 0, closed_total: by.closed ?? 0 };
}
