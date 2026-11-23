// H2(b): PyPI. XML-RPC changelog_since_serial on https://pypi.org/pypi.
// PyPI documents the XML-RPC API as frozen and says there is no JSON successor for the changelog;
// the Simple API only gives `_last-serial`. The matcher here is name-only: the changelog has no keywords.
import { nameMatches } from './lib/matcher.mjs';

const RPC = 'https://pypi.org/pypi';
const call = (method, ...ints) =>
  `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${ints.map((i) => `<param><value><int>${i}</int></value></param>`).join('')}</params></methodCall>`;

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Parse the array-of-arrays response of changelog_since_serial: [name, version|null, timestamp, action, serial]. */
export function parseChangelog(xml) {
  const out = [];
  for (const m of xml.matchAll(/<array>\s*<data>((?:(?!<array>|<\/data>)[\s\S])*)<\/data>\s*<\/array>/g)) {
    const vals = [...m[1].matchAll(/<value>\s*(?:<(string|int|i4|i8|nil)\s*\/?>([\s\S]*?)(?:<\/\1>)?)?\s*<\/value>/g)];
    if (vals.length < 5) continue;
    const cell = (v) => (v[1] === 'nil' ? null : v[1] === 'int' || v[1] === 'i4' || v[1] === 'i8' ? Number(v[2]) : unescape(v[2] ?? ''));
    const [name, version, ts, action, serial] = vals.map(cell);
    out.push({ name, version, timestamp: ts, action, serial });
  }
  return out;
}

export async function runPypi({ http, state = {}, now = Date.now() }) {
  const errors = [];
  const next = { ...state };
  const post = (body) => http.text(RPC, { method: 'POST', headers: { 'content-type': 'text/xml' }, body });
  const last = Number(/<int>(\d+)<\/int>/.exec(await post(call('changelog_last_serial')))?.[1]);
  if (!Number.isFinite(last)) throw new Error('changelog_last_serial: unparseable');
  if (state.serial == null) {
    next.serial = last;
    return { rows: [], state: next, errors, note: 'initialised at current serial' };
  }
  const events = parseChangelog(await post(call('changelog_since_serial', state.serial)));
  const rows = events.filter((e) => nameMatches(e.name)).map((e) => ({ serial: e.serial, id: e.name, version: e.version, action: e.action, timestamp: e.timestamp }));
  const maxSerial = events.reduce((m, e) => Math.max(m, e.serial), state.serial);
  next.serial = maxSerial;
  next.last_run_ms = now;
  return { rows, state: next, errors };
}
