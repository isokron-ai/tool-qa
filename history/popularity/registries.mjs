// H3 downloads: npm per-version + point counts, pypistats recent, crates (from the H2 dump subset).
const enc = (n) => n.replace('/', '%2F');
// A package that is gone (HTTP 404) goes in `missing`, not `errors`: the seed comes from a registry
// snapshot, and an unpublished package is data, not a broken run.
const notFound = (e) => /HTTP 404\b/.test(e.message);

/** npm: last-week per-version downloads and the point count. Both cover the same 7 days (the API only keeps a short per-version window). */
export async function npmPopularity(http, names, { now = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delayMs = 150 } = {}) {
  const rows = []; const errors = []; const missing = [];
  for (const name of names) {
    try {
      const [point, versions] = await Promise.all([
        http.json(`https://api.npmjs.org/downloads/point/last-week/${enc(name)}`),
        http.json(`https://api.npmjs.org/versions/${enc(name)}/last-week`),
      ]);
      rows.push({ ecosystem: 'npm', id: name, observed_at: new Date(now).toISOString(), window_start: point.start, window_end: point.end, downloads_week: point.downloads, per_version: versions.downloads ?? {} });
    } catch (e) { if (notFound(e)) missing.push(`npm:${name}`); else errors.push(`npm:${name}: ${e.message}`); }
    await sleep(delayMs);
  }
  return { rows, errors, missing };
}

export async function pypiPopularity(http, names, { now = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delayMs = 1000 } = {}) {
  const rows = []; const errors = []; const missing = [];
  for (const name of names) {
    try {
      const r = await http.json(`https://pypistats.org/api/packages/${encodeURIComponent(name.toLowerCase())}/recent`);
      rows.push({ ecosystem: 'pypi', id: name, observed_at: new Date(now).toISOString(), last_day: r.data?.last_day ?? null, last_week: r.data?.last_week ?? null, last_month: r.data?.last_month ?? null });
    } catch (e) { if (notFound(e)) missing.push(`pypi:${name}`); else errors.push(`pypi:${name}: ${e.message}`); }
    await sleep(delayMs); // pypistats asks for modest request rates
  }
  return { rows, errors, missing };
}

/** crates: project seeded crates out of the H2 subset rows (no network). */
export function cratesPopularity(subsetRows, names, { now = Date.now(), dumpTimestamp = null } = {}) {
  const want = new Set(names);
  const rows = []; const missing = [];
  const have = new Map(subsetRows.map((r) => [r.id, r]));
  for (const name of names) {
    const r = have.get(name);
    if (!r) { missing.push(`crates:${name}`); continue; } // left crates.io, or the subset predates the seed
    rows.push({ ecosystem: 'crates', id: name, observed_at: new Date(now).toISOString(), dump_timestamp: dumpTimestamp, downloads_total: r.downloads_total, versions: r.versions, latest_version_at: r.latest_version_at });
  }
  return { rows: want.size ? rows : [], errors: [], missing };
}
