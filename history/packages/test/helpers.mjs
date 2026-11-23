import { gzipSync } from 'node:zlib';

/** Mock fetch from a handler (url, init) -> {status?, body, headers?}. Records calls. */
export function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = await handler(String(url), init);
    const status = r.status ?? 200;
    const body = r.body;
    const headers = new Headers(r.headers ?? {});
    return {
      status, ok: status >= 200 && status < 300, headers,
      json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      body: r.stream ?? null,
    };
  };
  f.calls = calls;
  return f;
}

function tarEntry(name, content) {
  const data = Buffer.from(content);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
  h.write('        ', 148); h.write('0', 156); h.write('ustar\0' + '00', 257);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
export function makeTarGz(files) {
  return gzipSync(Buffer.concat([...Object.entries(files).map(([n, c]) => tarEntry(n, c)), Buffer.alloc(1024)]));
}
export const noSleep = async () => {};
