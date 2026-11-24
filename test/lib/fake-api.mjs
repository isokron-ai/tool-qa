// Test helpers: a fake GitHub REST API and a fake clock. No network, no secrets.
//
//   const api = fakeApi([
//     ['GET', /\/repos\/o\/r\/actions\/runs/, (req) => ({ body: { workflow_runs: [] } })],
//     ['POST', '/repos/o/r/actions/workflows/x.yml/dispatches', () => ({ status: 204 })],
//   ]);
//   await something({ fetch: api.fetch, apiUrl: API });
//   api.calls // [{ method, url, path, query, headers, body, json }]
//
// A route's pattern is matched against the path (without the query string). A
// string must match exactly; a RegExp is tested. The first match wins. A handler
// returns { status = 200, body, headers } or a Response. Unmatched requests get
// a 404 so a test fails loudly.

export const API = 'https://api.github.test';

function toResponse(out) {
  if (out instanceof Response) return out;
  const { status = 200, body, headers = {} } = out ?? {};
  const noBody = status === 204 || status === 304;
  const h = new Headers(headers);
  let payload = null;
  if (!noBody && body !== undefined) {
    if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) payload = body;
    else {
      payload = JSON.stringify(body);
      if (!h.has('content-type')) h.set('content-type', 'application/json');
    }
  }
  return new Response(payload, { status, headers: h });
}

export function fakeApi(routes = []) {
  const calls = [];
  async function fetch(input, init = {}) {
    const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? {});
    let body = init.body ?? null;
    if (body instanceof Uint8Array) body = Buffer.from(body).toString('utf8');
    let json;
    if (typeof body === 'string') {
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
    }
    const req = { method, url: url.href, path: url.pathname, query: url.searchParams, headers, body, json };
    calls.push(req);
    for (const [m, pattern, handler] of routes) {
      if (m !== '*' && m !== method) continue;
      const hit = typeof pattern === 'string' ? pattern === url.pathname : pattern.test(url.pathname);
      if (!hit) continue;
      return toResponse(await handler(req));
    }
    return toResponse({ status: 404, body: { message: `fake api: no route for ${method} ${url.pathname}` } });
  }
  return { fetch, calls };
}

/** A clock whose sleep() advances time instantly. */
export function fakeClock(start = Date.parse('2026-03-02T10:00:00Z')) {
  const c = {
    t: start,
    sleeps: [],
    now: () => c.t,
    sleep: async (ms) => {
      const n = Math.max(0, Number(ms) || 0);
      c.sleeps.push(n);
      c.t += n;
    },
  };
  return c;
}
