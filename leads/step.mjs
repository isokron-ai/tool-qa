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
// MAX_WRITES issue writes per run; the issues API family has its own budget
// (pump/budgets.mjs). Never throws: a failure is logged and counted in kv
// leads.last, and the next run tries again.

import { appendFileSync } from 'node:fs';

import { createClient } from '../pump/github.mjs';
import { filesLeads } from '../state/leads.mjs';
import { issueFor, MARKER, planFilings, renderPlan, titleTag } from './plan.mjs';

export const LEADS_LAST_KEY = 'leads.last';
/** Issue writes (create, close, reopen, comment) per pump run at most. */
export const MAX_WRITES = 20;
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
export async function leadStep({ db, mode, tierWeights, now, log = () => {}, mintToken, save, summaryFile, client: clientOpts = {}, maxWrites = MAX_WRITES, botLogin = process.env.LEADS_BOT_LOGIN || DEFAULT_BOT_LOGIN }) {
  const at = () => new Date(now()).toISOString();
  const note = { at: at(), mode, filed: 0, closed: 0, reopened: 0, adopted: 0, refiled: 0, errors: 0, writes: 0 };
  const done = new Map();
  try {
    if (mode === 'off' || db.schemaVersion() < 12) {
      db.setKv(LEADS_LAST_KEY, { ...note, off: true }, { now: now() });
      return note;
    }
    let plan = planFilings(db, { now: at(), tierWeights });
    Object.assign(note, counts(db), { planned: plan.file.length, capped: plan.capped.length, held: plan.held.length });

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
      const write = async (fn) => {
        if (note.writes >= maxWrites) return null;
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
          log(`leads: could not confirm the filing of ${e.lead.fingerprint} on ${e.lead.repo}: ${err?.message ?? err}`);
        }
      }
      if (plan.indoubt.length) plan = planFilings(db, { now: at(), tierWeights });

      // 2. Issues whose lead closed (3 clean re-checks) or came back.
      for (const [list, state, verb] of [[plan.close, 'closed', 'closed'], [plan.reopen, 'open', 'reopened']]) {
        for (const e of list) {
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
            if (note.writes + 2 > maxWrites) break;
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
            log(`leads: could not set issue #${e.lead.issue_number} on ${e.lead.repo} ${state}: ${err?.message ?? err}`);
          }
        }
      }

      // 3. New issues, within the caps: marked and saved first, then created.
      const issues = [];
      for (const e of plan.file) {
        if (issues.length + note.writes >= maxWrites) break;
        // Held leads never get here: planFilings runs the shape guard before handing out room (R-LEAD-42).
        const issue = issueFor(e, { now: at() });
        issues.push({ e, issue });
      }
      if (issues.length) {
        db.tx(() => {
          for (const { e } of issues) db.raw.prepare('UPDATE leads SET filing_started_at = ?, updated_at = ? WHERE fingerprint = ?').run(at(), at(), e.lead.fingerprint);
        });
        const saved = typeof save === 'function' ? await save('leads, before filing') : true;
        if (!saved) {
          log('leads: the state could not be saved before filing; nothing filed this run (the marks are looked up next run)');
        } else {
          for (const { e, issue } of issues) {
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
              done.set(e.lead.fingerprint, `filed #${number}`);
            } catch (err) {
              note.errors += 1;
              log(`leads: could not file ${e.lead.fingerprint} on ${e.lead.repo}: ${err?.message ?? err}`);
            }
          }
        }
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
  if (note.filed || note.closed || note.reopened || note.errors) log(`leads: filed ${note.filed}, closed ${note.closed}, reopened ${note.reopened}, errors ${note.errors} (${mode})`);
  return note;
}

/** Lead counts by status, and the open ones nobody has filed (the queue). */
function counts(db) {
  const rows = db.raw.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status').all();
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return { open: by.open ?? 0, filed_total: by.filed ?? 0, closed_total: by.closed ?? 0 };
}
