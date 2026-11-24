// release-diff's comparison: a published package artifact against the source
// tree at the commit it should come from. Pure functions over what
// scripts/lib/untar.mjs and unzip.mjs read; nothing here touches the network
// or runs anything from either side.
//
// Each file of the artifact is one of:
//   identical            same bytes as the source file
//   identical_eol        same once line endings are folded (CRLF, CR to LF)
//   explained            absent from the source, or different, for a reason
//                        normal packaging gives (EXPLAINED below)
//   unexplained_absent   not in the source, and no packaging reason found
//   unexplained_differs  in the source with other content, and no reason found
//   held                 security-class (indicators.mjs); kept only in the
//                        private held list and left out of every public count
//
// The artifact's folder in the source tree (a monorepo package, a src/
// layout) is found by vote: each artifact path votes for every folder under
// which the tree has the same path, and the folder with most votes wins. A
// wheel votes per top-level package, since a wheel can join packages from
// different folders.

import { scanText } from '../../ingest/redact.mjs';
import { createSourceIndex, looksText, scanIndicators, SECRET_FILE_RE, SECRET_RULES } from './indicators.mjs';

export const EXPLAINED = Object.freeze([
  'build_output', 'compiled_output', 'compiled_extension', 'copied_from_repo', 'generated_metadata',
  'generated_lockfile', 'generated_setup_py', 'generated_version_file', 'version_stamp', 'manifest',
]);

const BUILD_DIR_RE = /^(?:dist|build|lib|libs|out|output|esm|cjs|es|es5|es6|umd|types|typings|bundle|bundles|compiled|release|\.output|dist-[a-z0-9-]+|lib-[a-z0-9-]+)\//i;
const COMPILED_EXT_RE = /\.(?:js|mjs|cjs|jsx|d\.ts|d\.mts|d\.cts|js\.map|mjs\.map|cjs\.map|d\.ts\.map|map)$/i;
const SOURCE_EXT_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|coffee|svelte|vue|civet)$/i;
const DOC_RE = /(?:^|\/)(?:readme|license|licence|copying|notice|changelog|changes|history|authors|contributors|contributing|security|code_of_conduct)(?:\.[A-Za-z0-9]{1,8})?$/i;
const NATIVE_EXT_RE = /\.(?:so|pyd|dylib|dll)(?:\.[0-9.]+)?$/i;
const NATIVE_SRC_RE = /\.(?:c|cc|cpp|cxx|h|hpp|pyx|pxd|rs|go|f90|f)$/i;
const VERSION_FILE_RE = /(?:^|\/)(?:_version|version|__version__|_build_info)\.pyi?$/i;
const EXEC_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|pyw|pyc|pyo|sh|bash|zsh|bat|cmd|ps1|psm1|vbs|exe|dll|so|dylib|pyd|node|wasm|jar|bin|elf|com|scr|msi|app|appimage|deb|rpm|pl|rb|php|lua)$/i;
const BINARY_EXT_RE = /\.(?:exe|dll|so|dylib|pyd|node|wasm|jar|bin|elf|com|scr|msi|o|a|lib|class|pyc|pyo|zip|tar|gz|tgz|xz|bz2|7z|rar)$/i;
const IMAGE_FONT_RE = /\.(?:png|jpe?g|gif|webp|ico|svg|bmp|tiff?|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|pdf)$/i;

const base = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const foldEol = (buf) => buf.toString('latin1').replace(/\r\n?/g, '\n');

/**
 * Folder (with trailing '/', or '') of the source tree the paths come from, by
 * vote. One lookup per artifact path in `bySuffix` (suffixIndex), so the cost
 * follows the artifact, not artifact x tree.
 */
export function findPrefix(paths, treePaths, { hint = null, bySuffix = suffixIndex(treePaths) } = {}) {
  const votes = new Map();
  for (const p of paths) {
    for (const pre of bySuffix.get(p) ?? []) votes.set(pre, (votes.get(pre) ?? 0) + 1);
  }
  if (votes.size === 0) return { prefix: hint ?? null, votes: 0, hint_agrees: null };
  const best = Math.max(...votes.values());
  const tied = [...votes.entries()].filter(([, v]) => v === best).map(([k]) => k);
  const prefix = hint !== null && tied.includes(hint) ? hint : tied.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return { prefix, votes: best, hint_agrees: hint === null ? null : prefix === hint };
}

/** suffix of a tree path (the path itself, or what follows any '/') -> the folders (with trailing '/', or '') it sits under. */
export function suffixIndex(paths) {
  const m = new Map();
  for (const r of paths) {
    let at = 0;
    for (;;) {
      const suffix = r.slice(at);
      const pre = r.slice(0, at);
      const list = m.get(suffix);
      if (list) list.push(pre); else m.set(suffix, [pre]);
      const i = r.indexOf('/', at);
      if (i < 0) break;
      at = i + 1;
    }
  }
  return m;
}

/** Every folder above a path, as prefixes with a trailing '/': 'a/b/c.js' -> ['', 'a/', 'a/b/']. */
function ancestors(path) {
  const out = [''];
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) out.push(path.slice(0, i + 1));
  return out;
}

/**
 * The lookups compareArtifact makes against the tree, built once per tree:
 * folders holding native source, "folder + file name" pairs holding a source
 * file, and "folder + lowercase name" pairs for docs.
 */
export function treeIndexOf(tree, treePaths) {
  if (tree.lookups) return tree.lookups;
  const nativeDirs = new Set();
  const sourceAt = new Set();
  const nameAt = new Set();
  for (const r of treePaths) {
    const b = base(r);
    const dir = dirOf(r);
    nameAt.add(`${dir}\0${b.toLowerCase()}`);
    if (NATIVE_SRC_RE.test(r)) for (const a of ancestors(r)) nativeDirs.add(a);
    if (SOURCE_EXT_RE.test(r)) for (const a of ancestors(r)) sourceAt.add(`${a}\0${b}`);
  }
  tree.lookups = { nativeDirs, sourceAt, nameAt, bySuffix: tree.bySuffix ?? suffixIndex(treePaths) };
  return tree.lookups;
}

export function indexByBase(paths) {
  const m = new Map();
  for (const p of paths) {
    const b = base(p);
    const list = m.get(b);
    if (list) list.push(p); else m.set(b, [p]);
  }
  return m;
}

function isExecutable(path, mode) {
  return EXEC_EXT_RE.test(path) || (mode & 0o111) !== 0;
}

function isBinary(path, data) {
  if (BINARY_EXT_RE.test(path)) return true;
  if (IMAGE_FONT_RE.test(path)) return false;
  return data ? !looksText(data) : false;
}

// A version in a source line: x.y or x.y.z with a pre-release or build tail, or a template placeholder.
const VERSION_TOKEN_RE = /\d+(?:\.\d+){1,3}(?:(?:[-+]|\.?(?:a|b|rc|dev|post|alpha|beta|pre))[0-9A-Za-z.+-]*)?|\$\{[^}\n]*\}|\{\{[^}\n]*\}\}/g;

/**
 * Do two texts differ only in version strings? The lines that differ are
 * paired and a pair counts only when the artifact's line carries the artifact's
 * version and the two lines are the same once the version in each is blanked:
 * a line that changes anything else, or merely mentions "version", does not.
 */
export function onlyVersionLines(pkgText, srcText, version) {
  const a = pkgText.split('\n');
  const b = srcText.split('\n');
  const bs = new Map();
  for (const l of b) bs.set(l, (bs.get(l) ?? 0) + 1);
  const onlyA = [];
  for (const l of a) {
    const n = bs.get(l) ?? 0;
    if (n > 0) bs.set(l, n - 1); else onlyA.push(l);
  }
  const onlyB = [...bs.entries()].flatMap(([l, n]) => Array(n).fill(l));
  if (onlyA.length === 0 && onlyB.length === 0) return true;
  if (onlyA.length !== onlyB.length || onlyA.length > 6) return false;
  const v = String(version ?? '');
  if (!v) return false;
  const blankPkg = (l) => l.split(v).join('\0');
  const blankSrc = (l) => l.replace(VERSION_TOKEN_RE, '\0');
  if (!onlyA.every((l) => l.includes(v))) return false;
  const left = onlyA.map(blankPkg).sort();
  const right = onlyB.map(blankSrc).sort();
  return left.every((l, i) => l === right[i]);
}

const PLACEHOLDER_VERSION_RE = /^(?:0\.0\.0(?:-.*)?|0\.0\.0-development|0\.0\.0-semantic-release|.*placeholder.*|\$\{.*\}|)$/i;
const NPM_ADDED_KEYS = new Set(['gitHead', '_id', '_resolved', '_integrity', '_from', 'readme', 'readmeFilename', '_npmVersion', '_nodeVersion', '_npmUser', '_hasShrinkwrap', 'dist']);
const DEP_KEYS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies', 'bundleDependencies', 'bundledDependencies'];
const ENTRY_KEYS = new Set(['main', 'module', 'browser', 'types', 'typings', 'exports', 'bin', 'imports', 'files', 'directories', 'type']);
export const INSTALL_SCRIPTS = Object.freeze(['preinstall', 'install', 'postinstall']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Compare a published package.json with the source's. Keys and script names
 * are reported as values; no value of the manifest is kept.
 * @returns {{changes: {key: string, change: string, explained: string|null, level: string}[]}}
 */
export function comparePackageJson(pub, src) {
  const changes = [];
  const pc = isObj(src?.publishConfig) ? src.publishConfig : {};
  const keys = [...new Set([...Object.keys(pub ?? {}), ...Object.keys(src ?? {})])].sort();
  for (const key of keys) {
    const a = pub?.[key];
    const b = src?.[key];
    if (same(a, b)) continue;
    const change = a === undefined ? 'removed' : b === undefined ? 'added' : 'changed';
    let explained = null;
    let level = 'low';
    if (NPM_ADDED_KEYS.has(key)) explained = 'added_by_npm';
    else if (key === 'version') explained = 'version_stamp';
    else if (key === 'publishConfig' && change === 'removed') explained = 'removed_at_publish';
    else if (Object.hasOwn(pc, key) && same(pc[key], a)) explained = 'publish_config';
    else if (DEP_KEYS.includes(key)) {
      const pa = isObj(a) ? a : {};
      const sb = isObj(b) ? b : {};
      for (const dep of [...new Set([...Object.keys(pa), ...Object.keys(sb)])].sort()) {
        if (same(pa[dep], sb[dep])) continue;
        const dchange = pa[dep] === undefined ? 'removed' : sb[dep] === undefined ? 'added' : 'changed';
        const proto = typeof sb[dep] === 'string' && /^(?:workspace|catalog|link|file|portal|patch):/.test(sb[dep]);
        const dexplained = proto ? 'workspace_protocol' : dchange === 'removed' ? 'removed_at_publish' : key === 'devDependencies' ? 'dev_only' : null;
        changes.push({ key: `${key}.${dep}`, change: dchange, explained: dexplained, level: dexplained ? 'info' : (key === 'devDependencies' || key === 'peerDependencies' ? 'low' : 'high') });
      }
      continue;
    } else if (key === 'scripts') {
      const pa = isObj(a) ? a : {};
      const sb = isObj(b) ? b : {};
      for (const s of [...new Set([...Object.keys(pa), ...Object.keys(sb)])].sort()) {
        if (same(pa[s], sb[s])) continue;
        const schange = pa[s] === undefined ? 'removed' : sb[s] === undefined ? 'added' : 'changed';
        const install = INSTALL_SCRIPTS.includes(s);
        changes.push({ key: `scripts.${s}`, change: schange, explained: schange === 'removed' ? 'removed_at_publish' : null, level: schange === 'removed' ? 'info' : install ? 'high' : 'low' });
      }
      continue;
    } else if (change === 'removed') explained = 'removed_at_publish';
    else if (ENTRY_KEYS.has(key)) level = 'medium';
    changes.push({ key, change, explained, level: explained ? 'info' : level });
  }
  return { changes };
}

/** Section headers of the lines in which two TOML texts differ; version-only differences explained. */
export function compareTomlText(pubText, srcText, version) {
  if (pubText === srcText) return { changes: [] };
  if (onlyVersionLines(pubText, srcText, version)) return { changes: [{ key: 'version', change: 'changed', explained: 'version_stamp', level: 'info' }] };
  const sections = (text) => {
    const out = new Map();
    let cur = '(top)';
    for (const l of text.split('\n')) {
      const m = /^\s*\[\[?\s*([A-Za-z0-9_.\-"']{1,100})\s*\]\]?\s*$/.exec(l);
      if (m) { cur = m[1].replace(/["']/g, ''); continue; }
      if (!l.trim() || l.trim().startsWith('#')) continue;
      const list = out.get(cur) ?? [];
      list.push(l.trim());
      out.set(cur, list);
    }
    return out;
  };
  const a = sections(pubText);
  const b = sections(srcText);
  const changes = [];
  for (const k of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = (a.get(k) ?? []).join('\n');
    const y = (b.get(k) ?? []).join('\n');
    if (x === y) continue;
    const change = !a.has(k) ? 'removed' : !b.has(k) ? 'added' : 'changed';
    const explained = change !== 'removed' && onlyVersionLines(x, y, version) ? 'version_stamp' : null;
    const level = explained ? 'info' : /^(?:build-system|project\.scripts|project\.entry-points|project\.gui-scripts|tool\.setuptools\.cmdclass)/.test(k) ? 'high' : k === 'project' ? 'medium' : 'low';
    changes.push({ key: k.slice(0, 100), change, explained, level });
  }
  return { changes };
}

/** pyproject facts: the build backend, an in-tree backend, and version-from-VCS plugins. */
export function pyprojectFacts(text) {
  const t = typeof text === 'string' ? text : '';
  const backend = /^\s*build-backend\s*=\s*["']([A-Za-z0-9_.:-]{1,100})["']/m.exec(t)?.[1] ?? null;
  return {
    build_backend: backend,
    in_tree_backend: /^\s*backend-path\s*=/m.test(t),
    poetry: /poetry/i.test(backend ?? ''),
    vcs_version: /setuptools[_-]scm|hatch-vcs|versioningit|setuptools-git-versioning|dunamai|poetry-dynamic-versioning|pdm-backend|scm/i.test(t),
  };
}

/** Code in setup.py beyond a plain setup() call. */
export function setupPyIndicators(text) {
  const t = typeof text === 'string' ? text : '';
  const out = [];
  if (/\b(?:subprocess|os\.system|os\.popen|Popen)\b/.test(t)) out.push('process_spawn');
  if (/\b(?:urllib|requests|http\.client|socket|urlopen)\b/.test(t)) out.push('network');
  if (/\b(?:exec|eval)\s*\(/.test(t)) out.push('exec_eval');
  if (/cmdclass\s*=/.test(t)) out.push('custom_commands');
  if (/\b(?:base64|zlib|marshal)\b/.test(t)) out.push('decoding');
  return out;
}

/**
 * The commands an npm install runs, and the files they name.
 * @returns {{scripts: {name: string, command: string|null}[], files: string[]}}
 */
export function installScripts(pkgJson, artifactPaths) {
  const scripts = isObj(pkgJson?.scripts) ? pkgJson.scripts : {};
  const out = [];
  for (const name of INSTALL_SCRIPTS) if (typeof scripts[name] === 'string') out.push({ name, command: scripts[name] });
  // npm runs `node-gyp rebuild` when a package has binding.gyp and no install or preinstall script.
  if (artifactPaths.has('binding.gyp') && !scripts.install && !scripts.preinstall) out.push({ name: 'install', command: null, implicit: 'binding.gyp' });
  const files = new Set();
  for (const s of out) {
    for (const tok of String(s.command ?? '').split(/[\s;&|()<>"'=]+/)) {
      const p = tok.replace(/^\.\//, '');
      if (artifactPaths.has(p)) files.add(p);
      else if (artifactPaths.has(`${p}.js`)) files.add(`${p}.js`);
    }
  }
  return { scripts: out, files: [...files] };
}

/**
 * Compare one artifact with the source tree.
 *
 * @param {object} a
 * @param {'npm'|'pypi'} a.ecosystem
 * @param {'npm_tarball'|'sdist'|'wheel'} a.kind
 * @param {string} a.version
 * @param {Map<string, {path, size, mode, sha256, data}>} a.files   artifact files, top folder removed
 * @param {{links: object[], refused: object[], duplicates: string[], others: object[]}} a.archive
 * @param {object} tree   { files: Map<path, {size, mode, sha256, data?}>, index (createSourceIndex), byBase }
 * @param {object} [o]
 * @param {string|null} [o.hint]   the folder the publisher names (npm repository.directory), with trailing '/'
 * @param {() => boolean} [o.expired]   the compute deadline: when it says true the comparison stops with ComputeBudget
 * @returns {{summary: object, findings: object[], held: object[], held_truncated: number}}
 */
export function compareArtifact(a, tree, { hint = null, expired = () => false } = {}) {
  const findings = [];
  const held = [];
  const counts = { identical: 0, identical_eol: 0, explained: {}, unexplained_absent: 0, unexplained_differs: 0 };
  const treePaths = [...tree.files.keys()];
  const byBase = tree.byBase ?? indexByBase(treePaths);
  if (expired()) throw new ComputeBudget();
  const look = treeIndexOf(tree, treePaths);
  if (expired()) throw new ComputeBudget();
  const artPaths = new Set(a.files.keys());
  const index = tree.index ?? createSourceIndex();
  const treeHashes = tree.hashes ?? new Set([...tree.files.values()].map((f) => f.sha256));

  // Where the artifact lives in the tree.
  const metaPath = (p) => (a.kind === 'wheel' && /^[^/]+\.(?:dist-info|data)\//.test(p)) || (a.kind === 'sdist' && (p === 'PKG-INFO' || /^[^/]+\.egg-info\//.test(p) || /\.egg-info\//.test(p)));
  const prefixes = new Map(); // first segment (wheel) or '' -> prefix
  let prefixInfo;
  if (a.kind === 'wheel') {
    const groups = new Map();
    for (const p of artPaths) {
      if (metaPath(p)) continue;
      const top = p.includes('/') ? p.slice(0, p.indexOf('/') + 1) : '';
      const g = groups.get(top) ?? [];
      g.push(p);
      groups.set(top, g);
    }
    let votes = 0;
    for (const [top, list] of groups) {
      const f = findPrefix(list, treePaths, { bySuffix: look.bySuffix });
      prefixes.set(top, f.prefix);
      votes += f.votes;
    }
    const firstGroup = [...groups.entries()].sort((x, y) => y[1].length - x[1].length)[0];
    prefixInfo = { prefix: firstGroup ? prefixes.get(firstGroup[0]) ?? null : null, votes, hint_agrees: null };
  } else {
    prefixInfo = findPrefix([...artPaths].filter((p) => !metaPath(p)), treePaths, { hint, bySuffix: look.bySuffix });
    prefixes.set('', prefixInfo.prefix);
  }
  const prefixFor = (p) => {
    if (a.kind !== 'wheel') return prefixes.get('');
    const top = p.includes('/') ? p.slice(0, p.indexOf('/') + 1) : '';
    return prefixes.get(top) ?? null;
  };
  const rootPrefix = prefixInfo.prefix;

  // Package manifests and install-time files.
  const pkgJsonFile = a.files.get('package.json');
  let pkgJson = null;
  try { pkgJson = pkgJsonFile?.data ? JSON.parse(pkgJsonFile.data.toString('utf8')) : null; } catch { pkgJson = null; }
  const srcPkgJsonFile = rootPrefix !== null ? tree.files.get(`${rootPrefix}package.json`) : null;
  let srcPkgJson = null;
  try { srcPkgJson = srcPkgJsonFile?.data ? JSON.parse(srcPkgJsonFile.data.toString('utf8')) : null; } catch { srcPkgJson = null; }
  const pyprojectText = a.files.get('pyproject.toml')?.data?.toString('utf8') ?? null;
  const srcPyproject = rootPrefix !== null ? tree.files.get(`${rootPrefix}pyproject.toml`)?.data?.toString('utf8') ?? null : null;
  const py = pyprojectFacts(pyprojectText ?? srcPyproject);
  const install = a.ecosystem === 'npm' ? installScripts(pkgJson, artPaths) : { scripts: [], files: [] };
  const installFiles = new Set(install.files);
  if (a.kind === 'sdist' && artPaths.has('setup.py')) installFiles.add('setup.py');

  const heldPaths = new Set();
  const heldAt = new Map();
  let heldDropped = 0;
  const hold = (path, file, placement, reasons) => {
    const cur = heldAt.get(path);
    if (cur) { cur.indicators = [...new Set([...cur.indicators, ...reasons])].sort(); return; }
    if (heldPaths.has(path)) return;
    heldPaths.add(path);
    // The list is capped like the findings; a held path past the cap is still kept out of every public count.
    if (held.length >= MAX_HELD) { heldDropped++; return; }
    const entry = { artifact: a.kind, path, sha256: file?.sha256 ?? null, size: file?.size ?? null, placement, indicators: [...new Set(reasons)].sort() };
    held.push(entry);
    heldAt.set(path, entry);
  };

  // Every artifact file.
  let seenFiles = 0;
  for (const [path, f] of [...a.files].sort(([x], [y]) => x.localeCompare(y))) {
    if (++seenFiles % 128 === 0 && expired()) throw new ComputeBudget();
    const pre = prefixFor(path);
    const src = pre !== null ? tree.files.get(`${pre}${path}`) : undefined;
    let cls;
    let reason = null;
    if (src && src.sha256 === f.sha256) cls = 'identical';
    else if (src && f.data && src.data && foldEol(f.data) === foldEol(src.data)) cls = 'identical_eol';
    else if (src) {
      cls = 'differs';
      if (path === 'package.json' || path === 'pyproject.toml') reason = 'manifest';
      else if (a.kind === 'sdist' && path === 'setup.cfg') reason = 'generated_metadata';
      else if (f.data && src.data && looksText(f.data) && onlyVersionLines(f.data.toString('utf8'), src.data.toString('utf8'), a.version)) reason = 'version_stamp';
      // A file the source tree has, with other content, is never explained by its folder's name:
      // a republished lib/index.js that differs from the tracked one is content_differs.
    } else {
      cls = 'absent';
      if (metaPath(path)) reason = 'generated_metadata';
      else if (a.kind === 'sdist' && path === 'setup.py' && py.poetry) reason = 'generated_setup_py';
      else if (VERSION_FILE_RE.test(path) && (py.vcs_version || (f.size ?? 0) < 2048)) reason = 'generated_version_file';
      else if (a.ecosystem === 'npm' && path === 'npm-shrinkwrap.json') reason = 'generated_lockfile';
      else if (a.ecosystem === 'npm' && BUILD_DIR_RE.test(path)) reason = 'build_output';
      else if (COMPILED_EXT_RE.test(path) && compiledFrom(path, pre, look.sourceAt)) reason = 'compiled_output';
      else if (NATIVE_EXT_RE.test(path) && look.nativeDirs.has(pre ?? '')) reason = 'compiled_extension';
      else if (DOC_RE.test(path) && docInTree(path, pre, look.nameAt)) reason = 'copied_from_repo';
      // The same bytes are in the source at another path (a prepack copy, a shared file).
      else if (f.size > 0 && treeHashes.has(f.sha256)) reason = 'copied_from_repo';
      // setuptools writes setup.cfg into an sdist with only its [egg_info] tags when the project has none.
      else if (a.kind === 'sdist' && path === 'setup.cfg' && f.data && eggInfoOnly(f.data.toString('utf8'))) reason = 'generated_metadata';
      else if (a.ecosystem === 'pypi' && /\.pyc$/.test(path)) reason = null;
    }

    // Indicators: where they count (indicators.mjs).
    const placement = installFiles.has(path) ? 'install_time'
      : cls === 'absent' && !reason ? 'unexplained_absent'
        : cls === 'differs' && !reason ? 'unexplained_differs'
          : (reason === 'build_output' || reason === 'compiled_output') ? 'build_output'
            : cls === 'differs' ? 'explained_differs' : null;
    if (placement && f.data && looksText(f.data)) {
      const text = f.data.toString('utf8');
      const hits = scanIndicators(text).strong;
      const srcHits = src?.data ? scanIndicators(src.data.toString('utf8')).strong : [];
      const unexplainedHits = hits.filter((h) => !srcHits.some((s) => s.id === h.id) && !index.explains(h));
      const secret = f.size <= 1024 ** 2 ? scanText(text).filter((h) => SECRET_RULES.has(h.rule)).map((h) => `secret:${h.rule}`) : [];
      const secretKept = secret.length && !(src && src.sha256 === f.sha256) ? [...new Set(secret)] : [];
      if (unexplainedHits.length || secretKept.length) {
        hold(path, f, placement, [...unexplainedHits.map((h) => h.id), ...secretKept]);
        continue;
      }
    }
    if (cls === 'absent' && !reason && SECRET_FILE_RE.test(path)) {
      hold(path, f, 'unexplained_absent', ['secret_file_name']);
      continue;
    }

    if (cls === 'identical') counts.identical++;
    else if (cls === 'identical_eol') counts.identical_eol++;
    else if (reason) counts.explained[reason] = (counts.explained[reason] ?? 0) + 1;
    else if (cls === 'absent') {
      counts.unexplained_absent++;
      const executable = isExecutable(path, f.mode);
      const binary = isBinary(path, f.data);
      findings.push({
        kind: 'unexpected_file', artifact: a.kind, path, size: f.size, sha256: f.sha256, executable, binary,
        level: executable || binary || installFiles.has(path) ? 'high' : DOC_RE.test(path) || IMAGE_FONT_RE.test(path) ? 'low' : 'medium',
      });
    } else {
      counts.unexplained_differs++;
      const executable = isExecutable(path, f.mode);
      findings.push({ kind: 'content_differs', artifact: a.kind, path, size: f.size, sha256: f.sha256, source_sha256: src.sha256, executable, level: executable ? 'high' : 'medium' });
    }
  }

  // Manifests.
  if (a.ecosystem === 'npm' && pkgJson && srcPkgJson && !heldPaths.has('package.json')) {
    const { changes } = comparePackageJson(pkgJson, srcPkgJson);
    const open = changes.filter((c) => !c.explained);
    if (open.length) findings.push({ kind: 'manifest_differs', artifact: a.kind, path: 'package.json', changes: open.slice(0, 50), level: levelOf(open) });
  }
  if (a.kind === 'sdist' && pyprojectText !== null && srcPyproject !== null && !heldPaths.has('pyproject.toml')) {
    const { changes } = compareTomlText(pyprojectText, srcPyproject, a.version);
    const open = changes.filter((c) => !c.explained);
    if (open.length) findings.push({ kind: 'manifest_differs', artifact: a.kind, path: 'pyproject.toml', changes: open.slice(0, 50), level: levelOf(open) });
  }

  // What runs at install time.
  const srcScripts = isObj(srcPkgJson?.scripts) ? srcPkgJson.scripts : {};
  for (const s of install.scripts) {
    if (s.command !== null && scanIndicators(s.command).strong.length) {
      hold('package.json', pkgJsonFile, 'install_time', [`install_script:${s.name}`, ...scanIndicators(s.command).strong.map((h) => h.id)]);
      continue;
    }
    if (heldPaths.has('package.json')) continue;
    const inSource = s.command === null ? artPaths.has('binding.gyp') && tree.files.has(`${rootPrefix ?? ''}binding.gyp`) : srcScripts[s.name] === s.command;
    findings.push({ kind: 'install_script', artifact: a.kind, script: s.name, implicit: s.implicit ?? null, in_source: inSource, level: inSource ? 'medium' : 'high' });
  }
  if (a.kind === 'sdist' && artPaths.has('setup.py') && !heldPaths.has('setup.py')) {
    const f = a.files.get('setup.py');
    const src = rootPrefix !== null ? tree.files.get(`${rootPrefix}setup.py`) : undefined;
    const ind = setupPyIndicators(f.data?.toString('utf8'));
    findings.push({
      kind: 'setup_py_executes', artifact: a.kind, path: 'setup.py', in_source: !!src, identical: !!src && src.sha256 === f.sha256,
      generated: !src && py.poetry, custom_code: ind, level: ind.length ? 'medium' : 'low',
    });
  }
  if (a.kind === 'sdist' && py.in_tree_backend) findings.push({ kind: 'in_tree_build_backend', artifact: a.kind, path: 'pyproject.toml', level: 'medium' });
  if (a.kind === 'wheel') {
    for (const [path, f] of a.files) {
      if (!/^[^/]+\.pth$/.test(path) || heldPaths.has(path)) continue;
      const text = f.data && looksText(f.data) ? f.data.toString('utf8') : '';
      const importLine = text.split('\n').some((l) => /^import[ \t]/.test(l));
      if (importLine && scanIndicators(text).strong.length) { hold(path, f, 'install_time', ['pth_import', ...scanIndicators(text).strong.map((h) => h.id)]); continue; }
      findings.push({ kind: 'pth_file', artifact: a.kind, path, import_line: importLine, level: importLine ? 'high' : 'low' });
    }
  }

  // The archive itself.
  for (const l of a.archive.links ?? []) findings.push({ kind: 'link_in_package', artifact: a.kind, path: l.path, link_type: l.type, level: 'medium' });
  for (const r of a.archive.refused ?? []) findings.push({ kind: 'unsafe_entry_refused', artifact: a.kind, path: r.name, reason: r.reason, level: 'high' });
  for (const d of a.archive.duplicates ?? []) findings.push({ kind: 'duplicate_entry', artifact: a.kind, path: d, level: 'medium' });
  for (const o of a.archive.others ?? []) findings.push({ kind: 'special_entry', artifact: a.kind, path: o.path, entry_type: o.type, level: 'medium' });
  if (rootPrefix === null && a.files.size > 0) findings.push({ kind: 'no_source_overlap', artifact: a.kind, level: 'medium' });

  // Highest level first (a stable sort keeps file order within a level), at most MAX_FINDINGS.
  findings.sort((x, y) => LEVEL_ORDER[x.level] - LEVEL_ORDER[y.level]);
  const truncated = Math.max(0, findings.length - MAX_FINDINGS);
  findings.length = Math.min(findings.length, MAX_FINDINGS);
  const publicFiles = a.files.size - heldPaths.size;
  const summary = {
    artifact: a.kind,
    files: publicFiles,
    source_folder: rootPrefix === null ? null : rootPrefix === '' ? '.' : rootPrefix.replace(/\/$/, ''),
    source_folder_votes: prefixInfo.votes,
    source_folder_hint_agrees: prefixInfo.hint_agrees,
    identical: counts.identical,
    identical_eol: counts.identical_eol,
    explained: Object.entries(counts.explained).sort(([x], [y]) => x.localeCompare(y)).map(([reason, count]) => ({ reason, count })),
    unexplained_absent: counts.unexplained_absent,
    unexplained_differs: counts.unexplained_differs,
    install_scripts: install.scripts.filter((s) => !(s.command !== null && scanIndicators(s.command).strong.length)).map((s) => s.name),
    links: (a.archive.links ?? []).length,
    refused_entries: (a.archive.refused ?? []).length,
    findings_truncated: truncated,
  };
  return { summary, findings, held, held_truncated: heldDropped };
}

export const MAX_FINDINGS = 500;
export const MAX_HELD = 500;

/** The comparison ran past its compute deadline: our limit, not the package's. */
export class ComputeBudget extends Error {
  constructor() {
    super('release-diff: the comparison ran past its compute budget');
    this.name = 'ComputeBudget';
  }
}
const LEVEL_ORDER = Object.freeze({ high: 0, medium: 1, low: 2, info: 3 });

function levelOf(changes) {
  return changes.some((c) => c.level === 'high') ? 'high' : changes.some((c) => c.level === 'medium') ? 'medium' : 'low';
}

/** A setup.cfg that holds nothing but setuptools' [egg_info] tags. */
export function eggInfoOnly(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith(';'));
  return lines.length > 0 && lines[0] === '[egg_info]' && lines.slice(1).every((l) => /^tag_(?:build|date|svn_revision)\s*=/.test(l));
}

/** Is there a source file this compiled path comes from (same stem, under the artifact's folder)? */
function compiledFrom(path, pre, sourceAt) {
  const stem = base(path).replace(/\.(?:d\.ts|d\.mts|d\.cts)(?:\.map)?$/i, '').replace(/\.(?:js|mjs|cjs|jsx)(?:\.map)?$/i, '').replace(/\.map$/i, '');
  for (const ext of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'coffee', 'svelte', 'vue']) {
    if (sourceAt.has(`${pre ?? ''}\0${stem}.${ext}`)) return true;
  }
  return false;
}

/** A doc file is explained when the tree has one of that name (any case) at the artifact's folder or any folder above it. */
function docInTree(path, pre, nameAt) {
  if (path.includes('/')) return false;
  const name = path.toLowerCase();
  let dir = pre ?? '';
  for (;;) {
    if (nameAt.has(`${dir}\0${name}`)) return true;
    if (dir === '') return false;
    dir = dir.slice(0, -1);
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/') + 1) : '';
  }
}
