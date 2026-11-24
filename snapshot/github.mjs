// A small GitHub client for release assets, used by the state snapshot
// (snapshot/snapshot.mjs) and the restore drill (snapshot/restore.mjs).
//
// Idempotent requests are retried on 429, 5xx and network errors; POST is
// sent once. Asset downloads follow the redirect to the storage host without
// the Authorization header. The token is never logged and is scrubbed from
// every error message.

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const USER_AGENT = 'isokron-tool-qa-state-snapshot';

/** Mark an error as one that may pass if tried again later (err.transient = true). */
function transient(err) {
  err.transient = true;
  return err;
}

export function createReleaseClient({ repo, token, fetch = globalThis.fetch, apiUrl, sleep, log = () => {} }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))) {
    throw new Error(`repository must be "owner/name", got ${JSON.stringify(repo)}`);
  }
  const api = String(apiUrl || 'https://api.github.com').replace(/\/+$/, '');
  const scrub = (text) => (token ? String(text).split(token).join('***') : String(text));
  const doSleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  function headers(extra = {}, withAuth = true) {
    const h = { 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json', ...extra };
    if (withAuth && token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async function failure(method, url, res) {
    let detail = '';
    try {
      const text = await res.text();
      try { detail = JSON.parse(text).message || text; } catch { detail = text; }
    } catch { /* ignore */ }
    return new Error(scrub(`GitHub ${method} ${new URL(url).pathname} failed: HTTP ${res.status}${detail ? ` (${String(detail).slice(0, 200)})` : ''}`));
  }

  async function request(method, url, { body, extraHeaders, ok = [200], redirect, withAuth = true } = {}) {
    const attempts = method === 'POST' ? 1 : 3;
    for (let i = 1; ; i++) {
      let res;
      try {
        res = await fetch(url, { method, headers: headers(extraHeaders, withAuth), body, redirect });
      } catch (err) {
        if (i >= attempts) throw transient(new Error(scrub(`GitHub ${method} ${new URL(url).pathname} failed: ${err.message}`)));
        await doSleep(1000 * 2 ** (i - 1));
        continue;
      }
      if (ok.includes(res.status)) return res;
      if (RETRY_STATUS.has(res.status) && i < attempts) {
        const after = Number(res.headers.get('retry-after'));
        log(`GitHub ${method} ${new URL(url).pathname}: HTTP ${res.status}, retrying`);
        await doSleep(Number.isFinite(after) && after >= 0 ? after * 1000 : 1000 * 2 ** (i - 1));
        continue;
      }
      const err = await failure(method, url, res);
      // A server error, a rate limit or a lost connection may pass by itself;
      // callers can tell it from a real refusal (R-CHAOS-09).
      if (RETRY_STATUS.has(res.status) || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) transient(err);
      throw err;
    }
  }

  const json = (data) => ({ body: JSON.stringify(data), extraHeaders: { 'Content-Type': 'application/json' } });

  return {
    repo,
    scrub,
    request,
    /** The release with this tag, or null. */
    async getRelease(tag) {
      const res = await request('GET', `${api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { ok: [200, 404] });
      return res.status === 404 ? null : res.json();
    },
    /** Every asset of a release (the release object lists at most some; page through them). */
    async listAssets(release) {
      const out = [];
      for (let page = 1; page <= 20; page++) {
        const res = await request('GET', `${api}/repos/${repo}/releases/${release.id}/assets?per_page=100&page=${page}`);
        const list = await res.json();
        if (!Array.isArray(list)) break;
        out.push(...list);
        if (list.length < 100) break;
      }
      return out;
    },
    async createRelease({ tag, name, body }) {
      const res = await request('POST', `${api}/repos/${repo}/releases`, {
        ok: [201],
        ...json({ tag_name: tag, name, body, prerelease: true, make_latest: 'false' }),
      });
      return res.json();
    },
    async download(asset) {
      const res = await request('GET', `${api}/repos/${repo}/releases/assets/${asset.id}`, {
        ok: [200, 301, 302, 303, 307, 308],
        extraHeaders: { Accept: 'application/octet-stream' },
        redirect: 'manual',
      });
      if (res.status === 200) return Buffer.from(await res.arrayBuffer());
      const location = res.headers.get('location');
      if (!location) throw new Error(`asset ${asset.id} redirect had no location`);
      const blob = await request('GET', new URL(location, api).href, {
        withAuth: false,
        extraHeaders: { Accept: 'application/octet-stream' },
      });
      return Buffer.from(await blob.arrayBuffer());
    },
    async upload(release, name, data, label) {
      const base = String(release.upload_url).replace(/\{[^}]*\}$/, '');
      const q = `name=${encodeURIComponent(name)}${label ? `&label=${encodeURIComponent(label)}` : ''}`;
      const res = await request('POST', `${base}?${q}`, {
        ok: [201],
        body: data,
        extraHeaders: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length) },
      });
      return res.json();
    },
    async deleteAsset(id) {
      await request('DELETE', `${api}/repos/${repo}/releases/assets/${id}`, { ok: [204, 404] });
    },
    async renameAsset(id, name, label) {
      const res = await request('PATCH', `${api}/repos/${repo}/releases/assets/${id}`, { ...json(label === undefined ? { name } : { name, label }) });
      return res.json();
    },
    /**
     * The value of each named Actions variable as a job in `environment`
     * sees it: environment over repository over organization. Unset at every
     * level is `undefined`. Any read that fails other than with 404 throws,
     * so a caller that needs "the loop is stopped" fails closed.
     */
    async effectiveVariables(names, { environment = 'loop' } = {}) {
      const one = async (path) => {
        const res = await request('GET', `${api}/repos/${repo}/${path}`, { ok: [200, 404] });
        if (res.status === 404) return undefined;
        const v = await res.json();
        if (typeof v?.value !== 'string') throw new Error(`variable ${path} has no value`);
        return v.value;
      };
      let org = null;
      const out = {};
      for (const name of names) {
        if (!/^[A-Z0-9_]+$/.test(name)) throw new Error(`bad variable name ${JSON.stringify(name)}`);
        let value = environment ? await one(`environments/${encodeURIComponent(environment)}/variables/${name}`) : undefined;
        if (value === undefined) value = await one(`actions/variables/${name}`);
        if (value === undefined) {
          if (!org) {
            org = {};
            let total = Infinity;
            for (let page = 1, seen = 0; seen < total; page++) {
              if (page > 20) throw new Error('too many organization variables to read');
              const res = await request('GET', `${api}/repos/${repo}/actions/organization-variables?per_page=30&page=${page}`);
              const data = await res.json();
              const list = Array.isArray(data?.variables) ? data.variables : null;
              if (!list || !Number.isInteger(data.total_count)) throw new Error('could not read the organization variables shared with this repository');
              total = data.total_count;
              for (const v of list) org[v.name] = v.value;
              seen += list.length;
              if (list.length === 0) break;
            }
            if (Object.keys(org).length < total) throw new Error('the organization variable list was cut short');
          }
          value = org[name];
        }
        out[name] = value;
      }
      return out;
    },
    /** Runs of a workflow that have not finished (queued, waiting, pending, requested or in progress). */
    async activeRuns(file) {
      const out = [];
      for (const status of ['in_progress', 'queued', 'pending', 'waiting', 'requested']) {
        const res = await request('GET', `${api}/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?status=${status}&per_page=10`, { ok: [200, 404] });
        if (res.status === 404) continue;
        out.push(...((await res.json()).workflow_runs ?? []));
      }
      return out;
    },
  };
}
