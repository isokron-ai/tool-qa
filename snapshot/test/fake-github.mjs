// An in-memory stand-in for snapshot/github.mjs createReleaseClient(), with
// hooks to play the pump pushing while a copy is in flight.
import { createHash } from 'node:crypto';

export const AGE_HEAD = 'age-encryption.org/v1\n';
export const sha = (b) => createHash('sha256').update(b).digest('hex');
export const cipher = (text) => Buffer.from(`${AGE_HEAD}-> X25519 fake\n${text}`);

export function fakeGh({ repo = 'isokron-ai/tool-qa', vars = {}, active = {} } = {}) {
  let nextId = 1000;
  let clock = Date.parse('2026-11-24T00:00:00Z');
  const tick = () => new Date((clock += 1000)).toISOString().replace(/\.\d+Z$/, 'Z');
  const releases = new Map();
  const blobs = new Map();
  const hooks = { beforeDownload: null, afterDownload: null };
  const calls = [];
  const copy = (a) => ({ ...a });

  function release(tag) {
    if (!releases.has(tag)) {
      const id = nextId++;
      releases.set(tag, { id, tag_name: tag, upload_url: `https://uploads.example/${id}/assets{?name,label}`, assets: [] });
    }
    return releases.get(tag);
  }
  function addAsset(tag, name, data, label) {
    const a = { id: nextId++, name, label: label ?? '', size: data.length, state: 'uploaded', updated_at: tick() };
    blobs.set(a.id, Buffer.from(data));
    release(tag).assets.push(a);
    return a;
  }
  function findAsset(id) {
    for (const r of releases.values()) {
      const a = r.assets.find((x) => x.id === id);
      if (a) return { r, a };
    }
    return null;
  }

  const gh = {
    repo,
    calls,
    hooks,
    blobs,
    releases,
    async getRelease(tag) {
      calls.push(['getRelease', tag]);
      const r = releases.get(tag);
      return r ? { ...r, assets: r.assets.map(copy) } : null;
    },
    async listAssets(rel) {
      calls.push(['listAssets', rel.tag_name]);
      return [...releases.values()].find((r) => r.id === rel.id).assets.map(copy);
    },
    async createRelease({ tag }) {
      calls.push(['createRelease', tag]);
      const r = release(tag);
      return { ...r, assets: [] };
    },
    async download(asset) {
      calls.push(['download', asset.id]);
      if (hooks.beforeDownload) await hooks.beforeDownload(asset);
      const b = blobs.get(asset.id);
      if (!b) throw new Error(`GitHub GET asset ${asset.id} failed: HTTP 404`);
      const out = Buffer.from(b);
      if (hooks.afterDownload) return (await hooks.afterDownload(asset, out)) ?? out;
      return out;
    },
    async upload(rel, name, data, label) {
      calls.push(['upload', name]);
      const r = [...releases.values()].find((x) => x.id === rel.id);
      return copy(addAsset(r.tag_name, name, data, label));
    },
    async deleteAsset(id) {
      calls.push(['delete', id]);
      const f = findAsset(id);
      if (f) f.r.assets = f.r.assets.filter((x) => x.id !== id);
      blobs.delete(id);
    },
    async renameAsset(id, name, label) {
      calls.push(['rename', id, name]);
      const f = findAsset(id);
      f.a.name = name;
      if (label !== undefined) f.a.label = label;
      f.a.updated_at = tick();
      return copy(f.a);
    },
    async effectiveVariables(names) {
      calls.push(['effectiveVariables', names.join(',')]);
      if (vars instanceof Error) throw vars;
      return Object.fromEntries(names.map((n) => [n, vars[n]]));
    },
    async activeRuns(file) {
      return active[file] ?? [];
    },
  };

  /** The pump pushing: a new state.sqlite replaces the old one (new id, label, bytes). */
  function pushState(data, { label } = {}) {
    const r = release('state');
    r.assets = r.assets.filter((a) => a.name !== 'state.sqlite');
    return addAsset('state', 'state.sqlite', data, label ?? `sha256:${sha(data)}`);
  }
  const assetsOf = (tag) => (releases.get(tag)?.assets ?? []).map(copy);
  const manifestOf = () => {
    const a = assetsOf('state-snapshots').find((x) => x.name === 'manifest.json');
    return a ? JSON.parse(blobs.get(a.id).toString('utf8')) : null;
  };
  return { gh, pushState, addAsset, assetsOf, manifestOf, blobs };
}
