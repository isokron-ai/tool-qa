import { readFileSync } from 'node:fs';

export const ECOSYSTEMS = new Set(['npm', 'pypi', 'crates', 'github']);

/** Parse seed text into {ecosystem: [names]} (deduplicated, order kept). Throws on a malformed line. */
export function parseSeed(text) {
  const out = { npm: [], pypi: [], crates: [], github: [] };
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const at = line.indexOf(':');
    const eco = at < 0 ? '' : line.slice(0, at).trim().toLowerCase();
    const name = at < 0 ? '' : line.slice(at + 1).trim();
    if (!ECOSYSTEMS.has(eco) || !name) throw new Error(`seed line ${i + 1}: expected ecosystem:name, got "${raw.trim()}"`);
    if (eco === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`seed line ${i + 1}: github name must be owner/repo`);
    if (!out[eco].includes(name)) out[eco].push(name);
  });
  return out;
}

export const readSeed = (path) => parseSeed(readFileSync(path, 'utf8'));
