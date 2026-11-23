// Small fetch wrapper: User-Agent, retry on 429/5xx with Retry-After, injectable fetch/sleep for tests.
const UA = 'isokron-tool-qa-history/1 (+https://github.com/isokron-ai/tool-qa)';

export function createHttp({ fetch: f = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 4, headers = {} } = {}) {
  async function request(url, { method = 'GET', headers: h = {}, body } = {}) {
    let attempt = 0;
    for (;;) {
      const res = await f(url, { method, body, headers: { 'user-agent': UA, ...headers, ...h } });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) * 1000 : 1000 * 2 ** attempt);
        attempt++;
        continue;
      }
      return res;
    }
  }
  async function json(url, opts) {
    const res = await request(url, opts);
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    return res.json();
  }
  async function text(url, opts) {
    const res = await request(url, opts);
    if (!res.ok) throw new Error(`${opts?.method ?? 'GET'} ${url} -> HTTP ${res.status}`);
    return res.text();
  }
  return { request, json, text };
}
