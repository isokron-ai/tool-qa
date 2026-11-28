// meta-backend's reader and classifier: what a server's write tools write to,
// from the text of its repository. Pure: no network, no filesystem. The lane
// (meta/backend.mjs) feeds it one file at a time, then asks for the result.
//
//   const a = createAnalyzer({ maps });
//   a.addFile('package.json', text);            // every file the lane read
//   const v = a.result({ repo, commit, source }); // the write_backend value
//
// Signals, each with a weight (WEIGHTS). Per backend, a signal kind counts
// once, at its highest weight; the score is the sum over kinds:
//   dependency      a package manifest names a client library (package.json,
//                   pyproject.toml, requirements*.txt, setup.py, setup.cfg,
//                   Pipfile, go.mod, Cargo.toml, pom.xml, build.gradle,
//                   *.csproj); a dev or test dependency is dev_dependency
//   compose_image   a docker-compose service image
//   prisma_provider a Prisma datasource provider
//   url_scheme      a connection URL (postgres://, redis://, ...) in code or
//                   config; in a README it weighs less
//   code_token      a call or import that names the backend (code)
//   host_literal    an https URL of the service's API host in code
//   env_name        an env var the backend's clients read, by exact name; a
//                   name with the backend's prefix weighs less
//   openapi_file    an OpenAPI or Swagger description in the repository
//   fs_write        file writes in code (FS_RULE)
//   tool_names      the tool names found in code (write_tools)
// Code under test, example or fixture folders weighs less (TEST_PATH_RE).
//
// What is kept: names we matched (a dependency, an image, a scheme, a host, a
// token from our maps), env var NAMES (never a value), repository paths, and
// tool names; all are upstream text (redaction R1) and go through the lane's
// sanitize(). Nothing else of a file is kept.
//
// The class (local_full, mock_min, none) follows the primary backend (the
// highest score; ties: a usable stand-in first, then a spec, then the id):
//   local_full  its stand-in in stand-ins.json has fidelity real or faithful
//               and cleared true
//   mock_min    else it has a spec in spec-urls.json, or the repository holds
//               an OpenAPI description (and no stand-in or spec otherwise)
//   none        else, with a reason (REASONS)
// A server whose static tool names are all read-like (at least
// MIN_TOOLS_FOR_READ_ONLY names, none write-like) is none, no_write_tools_seen.

export const SCAN_VERSION = '1.0.0';

export const CLASSES = Object.freeze(['local_full', 'mock_min', 'none']);
export const MODE_OF = Object.freeze({ local_full: 'full', mock_min: 'min', none: 'none' });
export const REASONS = Object.freeze(['no_backend_signal', 'hosted_without_spec', 'stand_in_not_cleared', 'no_stand_in', 'not_a_store', 'no_write_tools_seen']);
export const KINDS = Object.freeze(['sql', 'kv', 'document', 'search', 'graph', 'vector', 'queue', 'object_store', 'mail', 'filesystem', 'git', 'cluster', 'service', 'hosted_api', 'browser']);
export const FIDELITIES = Object.freeze(['real', 'faithful', 'partial', 'not_faithful']);
export const SPEC_FORMATS = Object.freeze(['openapi3', 'swagger2', 'google_discovery', 'smithy', 'graphql_sdl', 'graphql_introspection']);
export const SIGNAL_KEYS = Object.freeze(['npm', 'pypi', 'go', 'cargo', 'maven', 'nuget', 'images', 'url_schemes', 'prisma', 'env', 'env_prefix', 'code', 'hosts']);

export const WEIGHTS = Object.freeze({
  dependency: 4, dev_dependency: 1, compose_image: 4, prisma_provider: 4, url_scheme: 3, url_scheme_readme: 2,
  code_token: 3, code_token_test: 1, host_literal: 3, host_literal_test: 1, env_name: 2, env_name_readme: 1, env_prefix: 1, openapi_file: 3,
  fs_write: 2, tool_names: 2,
});
/** A backend is found (primary or secondary) at this score, with at least one strong signal; below it, only a candidate. */
export const FOUND_SCORE = 4;
/**
 * Signals that can carry a backend on their own. Weak ones (a dev dependency, test code, a README, an env prefix)
 * only add up with a strong one; env names from code or config are strong for a hosted API (its key is how a server
 * reaches it), and the filesystem needs its file-shaped tools (FS_RULE).
 */
export const ANCHOR_SIGNALS = new Set(['dependency', 'compose_image', 'prisma_provider', 'code_token', 'host_literal', 'tool_names']);
export const STRONG_SIGNALS = new Set(['dependency', 'compose_image', 'prisma_provider', 'url_scheme', 'code_token', 'host_literal', 'tool_names']);
export const HIGH_SCORE = 6;
export const MIN_TOOLS_FOR_READ_ONLY = 3;
export const MAX_EVIDENCE = 40;
export const MAX_ENV_NAMES = 40;
export const MAX_TOOL_NAMES = 500;
export const MAX_TOOL_SAMPLE = 12;
export const MAX_CONFIG_CHARS = 256 * 1024;
export const MAX_README_CHARS = 512 * 1024;

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
/**
 * Env names never kept or sent (R-WB-15): the runtime's, the shell's, the CI runner's and the loader's own. A worker
 * that sets every listed name to point at a stand-in must never be told to set one of these; a server that reads
 * PATH or HOME says nothing about its backend.
 */
export const ENV_DENY_RE = /^(?:PATH|HOME|USER|USERNAME|LOGNAME|SHELL|PWD|OLDPWD|TERM|LANG|LANGUAGE|TZ|IFS|PS[1-4]|BASH_ENV|ENV|CDPATH|TMPDIR|TMP|TEMP|HOSTNAME|DEBUG|NODE_ENV|CI|LC_[A-Z_]+|LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|NODE_[A-Z0-9_]+|NPM_[A-Z0-9_]+|YARN_[A-Z0-9_]+|PNPM_[A-Z0-9_]+|PYTHON[A-Z0-9_]*|PIP_[A-Z0-9_]+|VIRTUAL_ENV|CONDA_[A-Z0-9_]+|UV_[A-Z0-9_]+|GITHUB_(?:ACTIONS|ACTOR|ENV|EVENT_[A-Z_]+|OUTPUT|PATH|REF[A-Z_]*|REPOSITORY[A-Z_]*|RUN_[A-Z_]+|SHA|STEP_SUMMARY|WORKFLOW[A-Z_]*|WORKSPACE|JOB)|RUNNER_[A-Z0-9_]+|ACTIONS_[A-Z0-9_]+|XDG_[A-Z0-9_]+|SSL_CERT_[A-Z_]+|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|GIT_(?:DIR|WORK_TREE|SSH|SSH_COMMAND|ASKPASS|EXEC_PATH|CONFIG[A-Z0-9_]*|TERMINAL_PROMPT|TRACE[A-Z0-9_]*|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PROXY_COMMAND|TEMPLATE_DIR|NAMESPACE|CEILING_DIRECTORIES|ALLOW_PROTOCOL|PAGER|EDITOR)|JAVA_HOME|GOPATH|GOROOT|GOFLAGS|CARGO_[A-Z0-9_]+|RUST[A-Z0-9_]*)$/;
/** An env name we keep: name-shaped and not one of ENV_DENY_RE. */
export const keepEnvName = (n) => typeof n === 'string' && ENV_NAME_RE.test(n) && !ENV_DENY_RE.test(n);
/** An env name that holds a hosted service's credential. */
const HOSTED_KEY_ENV_RE = /_(?:API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|PAT)$/;
/** An env name that points a server at a host: its base-URL knob. */
export const BASE_URL_ENV_RE = /(?:_URL|_URI|_HOST|_HOSTNAME|_ENDPOINT|_BASE_URL|_BASE|_ADDR|_ADDRESS|_SERVER|_API_URL|_DOMAIN|_INSTANCE)$/;
/** README env names are kept only when they look like configuration of a backend. */
const README_ENV_RE = /(?:_URL|_URI|_HOST|_ENDPOINT|_TOKEN|_KEY|_SECRET|_PASSWORD|_DSN|_DATABASE|_DB|_ADDR|_USER|_USERNAME|_ID)$|^(?:DATABASE|DB|KUBECONFIG)/;
/** Folders whose code says little about the server's own backend. */
/** Folders whose OpenAPI files are samples, not the server's (a spec/ folder is kept: it often holds the API's). */
export const SAMPLE_PATH_RE = /(?:^|\/)(?:tests?|__tests__|e2e|fixtures?|examples?|samples?|demo|testdata|mocks?|__mocks__)\//i;
export const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e|fixtures?|examples?|samples?|demo|benchmarks?|testdata|mocks?|__mocks__|docs?)\//i;
/** Folders never read. */
export const SKIP_PATH_RE = /(?:^|\/)(?:node_modules|vendor|dist|build|out|\.next|target|\.venv|venv|site-packages|__pycache__|third_party|coverage|\.git|bower_components|\.yarn|\.pnpm-store)\//;

export const CODE_EXT_RE = /\.(?:m?[jt]sx?|c[jt]s|py|go|rs|java|kt|kts|cs|rb|php|swift|scala|ex|exs|clj|dart|lua)$/i;
const README_RE = /(?:^|\/)readme(?:\.[a-z]{1,8})?$/i;
const ENV_FILE_RE = /(?:^|\/)(?:\.env\.(?:example|sample|template|dist|defaults?|local\.example|development\.example)|example\.env|env\.example|sample\.env|\.env-example|\.env_example)$/i;
const COMPOSE_RE = /(?:^|\/)(?:docker-)?compose(?:[.-][A-Za-z0-9_-]+)?\.ya?ml$/i;
const LOCK_RE = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|composer\.lock|tsconfig[\w.-]*\.json|\.eslintrc[\w.-]*|renovate\.json|\.prettierrc[\w.-]*|deno\.lock|bun\.lock)$/i;
const SPEC_NAME_RE = /(?:^|\/)[^/]*(?:openapi|swagger)[^/]*\.(?:json|ya?ml)$/i;

/** Manifest file names the reader understands (by base name). */
export function manifestKind(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base === 'package.json') return 'npm';
  if (base === 'pyproject.toml') return 'pyproject';
  if (/^requirements[\w.-]*\.(?:txt|in)$/i.test(base)) return 'requirements';
  if (base === 'setup.py') return 'setup_py';
  if (base === 'setup.cfg') return 'setup_cfg';
  if (base === 'Pipfile') return 'pipfile';
  if (base === 'go.mod') return 'gomod';
  if (base === 'Cargo.toml') return 'cargo';
  if (base === 'pom.xml') return 'pom';
  if (base === 'build.gradle' || base === 'build.gradle.kts') return 'gradle';
  if (/\.csproj$/i.test(base)) return 'csproj';
  if (base === 'schema.prisma' || /\.prisma$/.test(base)) return 'prisma';
  return null;
}

/** What the lane should read of a path: a kind, or null to leave it. */
export function fileRole(path) {
  if (SKIP_PATH_RE.test(`/${path}`)) return null;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (manifestKind(path)) return 'manifest';
  if (COMPOSE_RE.test(path)) return 'compose';
  if (ENV_FILE_RE.test(path)) return 'env_example';
  if (base === 'server.json') return 'server_json';
  if (base === 'manifest.json' && !path.includes('/')) return 'mcpb_manifest';
  if (README_RE.test(path) && path.split('/').length <= 3) return 'readme';
  if (CODE_EXT_RE.test(base)) return 'code';
  if (LOCK_RE.test(base)) return null;
  if (/\.(?:json|ya?ml)$/i.test(base)) return 'maybe_spec';
  return null;
}

// ---------------------------------------------------------------- maps

/**
 * Merge the two data maps into one table of backends. An id in both is one
 * backend: its stand-in from stand-ins.json, its spec from spec-urls.json, the
 * signals of both.
 */
export function mergeMaps(standIns, specUrls) {
  const table = new Map();
  const add = (id, part) => {
    const cur = table.get(id) ?? { id, kind: null, stand_in: null, spec: null, not_a_store: false, signals: Object.fromEntries(SIGNAL_KEYS.map((k) => [k, []])) };
    if (part.kind && !cur.kind) cur.kind = part.kind;
    if (part.stand_in !== undefined && part.stand_in !== null) cur.stand_in = part.stand_in;
    if (part.spec) cur.spec = part.spec;
    if (part.not_a_store === true) cur.not_a_store = true;
    for (const k of SIGNAL_KEYS) for (const v of part.signals?.[k] ?? []) if (!cur.signals[k].includes(v)) cur.signals[k].push(v);
    table.set(id, cur);
  };
  for (const [id, b] of Object.entries(standIns?.backends ?? {})) add(id, b);
  for (const [id, s] of Object.entries(specUrls?.services ?? {})) add(id, { kind: 'hosted_api', spec: s.spec ?? null, signals: s.signals });
  return table;
}

/** Can writecheck's full mode run this backend's stand-in? */
export const usableStandIn = (b) => Boolean(b?.stand_in && (b.stand_in.fidelity === 'real' || b.stand_in.fidelity === 'faithful') && b.stand_in.cleared === true);

const normPy = (n) => n.toLowerCase().replace(/[_.]+/g, '-');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Lookup indexes built once per lane run from the merged table. */
export function buildIndex(table) {
  const idx = {
    npm: new Map(), pypi: new Map(), cargo: new Map(), nuget: new Map(), maven: new Map(), go: [], images: new Map(),
    schemes: new Map(), prisma: new Map(), env: new Map(), envPrefix: [], hosts: [], code: new Map(),
  };
  const push = (m, k, id) => { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(id)) m.get(k).push(id); };
  for (const [id, b] of table) {
    const s = b.signals;
    for (const n of s.npm) push(idx.npm, n.toLowerCase(), id);
    for (const n of s.pypi) push(idx.pypi, normPy(n), id);
    for (const n of s.cargo) push(idx.cargo, n.toLowerCase(), id);
    for (const n of s.nuget) push(idx.nuget, n.toLowerCase(), id);
    for (const n of s.maven) push(idx.maven, n.toLowerCase(), id);
    for (const n of s.go) idx.go.push([n.toLowerCase(), id]);
    for (const n of s.images) push(idx.images, n.toLowerCase(), id);
    for (const n of s.url_schemes) push(idx.schemes, n.toLowerCase(), id);
    for (const n of s.prisma) push(idx.prisma, n.toLowerCase(), id);
    for (const n of s.env) push(idx.env, n, id);
    for (const n of s.env_prefix) idx.envPrefix.push([n, id]);
    for (const n of s.hosts) {
      const slash = n.indexOf('/');
      idx.hosts.push({ host: (slash < 0 ? n : n.slice(0, slash)).toLowerCase(), path: slash < 0 ? '' : n.slice(slash), id });
    }
    for (const n of s.code) push(idx.code, n, id);
  }
  // Longest first, so postgresql:// is not read as postgres plus "ql".
  const schemes = [...idx.schemes.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  idx.schemeRe = schemes.length ? new RegExp(`(?<![A-Za-z0-9+.-])(${schemes.join('|')})(?:\\+[a-z0-9]{1,20})?:\\/\\/`, 'gi') : null;
  const tokens = [...idx.code.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  idx.codeRe = tokens.length ? new RegExp(tokens.join('|'), 'g') : null;
  idx.go.sort((a, b) => b[0].length - a[0].length);
  idx.envPrefix.sort((a, b) => b[0].length - a[0].length);
  return idx;
}

// ---------------------------------------------------------------- manifests

/** Dependency names of a manifest: [{name, dev}] (names as written; the caller normalises). */
export function manifestDeps(kind, text) {
  const out = [];
  const add = (name, dev) => { if (typeof name === 'string' && name.length > 0 && name.length <= 214) out.push({ name, dev }); };
  if (kind === 'npm') {
    let doc;
    try { doc = JSON.parse(text); } catch { return out; }
    if (!doc || typeof doc !== 'object') return out;
    for (const [key, dev] of [['dependencies', false], ['optionalDependencies', false], ['peerDependencies', false], ['devDependencies', true]]) {
      const d = doc[key];
      if (d && typeof d === 'object' && !Array.isArray(d)) for (const n of Object.keys(d)) add(n, dev);
    }
    return out;
  }
  if (kind === 'requirements') {
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,100})/.exec(line);
      if (m && !line.trimStart().startsWith('-') && !line.trimStart().startsWith('#')) add(m[1], false);
    }
    return out;
  }
  if (kind === 'pyproject' || kind === 'pipfile' || kind === 'cargo') return tomlDeps(kind, text);
  if (kind === 'setup_py') {
    // indexOf, then a bounded slice: no regex scans the whole file from every position (R-WB-14).
    const list = (key) => {
      const i = text.indexOf(key);
      if (i < 0) return null;
      const open = text.indexOf('[', i);
      if (open < 0 || open - i > 40) return null;
      const close = text.indexOf(']', open);
      return text.slice(open + 1, close < 0 ? open + 20000 : Math.min(close, open + 20000));
    };
    const m = list('install_requires');
    if (m) for (const q of m.matchAll(/['"][ \t]*([A-Za-z0-9][A-Za-z0-9._-]{0,100})/g)) add(q[1], false);
    const t = list('tests_require');
    if (t) for (const q of t.matchAll(/['"][ \t]*([A-Za-z0-9][A-Za-z0-9._-]{0,100})/g)) add(q[1], true);
    return out;
  }
  if (kind === 'setup_cfg') {
    const lines = text.split(/\r?\n/);
    let on = false;
    for (const line of lines) {
      if (/^install_requires\s*=/.test(line)) { on = true; const rest = line.split('=')[1]; const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,100})/.exec(rest ?? ''); if (m) add(m[1], false); continue; }
      if (on) {
        if (/^\s+\S/.test(line)) { const m = /^\s+([A-Za-z0-9][A-Za-z0-9._-]{0,100})/.exec(line); if (m) add(m[1], false); } else on = false;
      }
    }
    return out;
  }
  if (kind === 'gomod') {
    let block = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (/^require\s*\($/.test(line)) { block = true; continue; }
      if (block && line === ')') { block = false; continue; }
      const m = block ? /^([^\s]+)\s+v[^\s]+(.*)$/.exec(line) : /^require\s+([^\s(]+)\s+v[^\s]+(.*)$/.exec(line);
      if (m) add(m[1], /\/\/\s*indirect/.test(m[2]));
    }
    return out;
  }
  if (kind === 'pom') {
    for (const part of text.split('<dependency>').slice(1)) {
      const end = part.indexOf('</dependency>');
      const body = part.slice(0, end < 0 ? 0 : Math.min(end, 2000));
      const g = /<groupId>[ \t\r\n]*([^<\s]{1,200})[ \t\r\n]*<\/groupId>/.exec(body);
      const a = /<artifactId>[ \t\r\n]*([^<\s]{1,200})[ \t\r\n]*<\/artifactId>/.exec(body);
      if (g && a) add(`${g[1]}:${a[1]}`, /<scope>[ \t\r\n]*test[ \t\r\n]*<\/scope>/.test(body));
    }
    return out;
  }
  if (kind === 'gradle') {
    for (const line of text.split(/\r?\n/)) {
      const m = /\b(\w+)\s*\(?\s*['"]([A-Za-z0-9._-]{1,200}):([A-Za-z0-9._-]{1,200})(?::[^'"]{0,100})?['"]/.exec(line);
      if (m) add(`${m[2]}:${m[3]}`, /^test/i.test(m[1]));
    }
    return out;
  }
  if (kind === 'csproj') {
    for (const m of text.matchAll(/<PackageReference\s+Include\s*=\s*"([^"]{1,200})"/gi)) add(m[1], false);
    return out;
  }
  return out;
}

/** The dependency tables of pyproject.toml, Pipfile and Cargo.toml, read line by line (no full TOML parser). */
function tomlDeps(kind, text) {
  const out = [];
  let table = '';
  let arrayKey = null; // inside a multi-line array whose strings are requirements
  let arrayDev = false;
  const reqName = (s) => /^\s*([A-Za-z0-9][A-Za-z0-9._-]{0,100})/.exec(s)?.[1] ?? null;
  const prodTables = kind === 'cargo' ? /^(?:dependencies|workspace\.dependencies|target\..+\.dependencies|build-dependencies)$/ : kind === 'pipfile' ? /^packages$/ : /^tool\.poetry\.dependencies$/;
  const devTables = kind === 'cargo' ? /^(?:dev-dependencies|target\..+\.dev-dependencies)$/ : kind === 'pipfile' ? /^dev-packages$/ : /^(?:tool\.poetry\.(?:dev-dependencies|group\.[^.]+\.dependencies)|dependency-groups)$/;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (arrayKey) {
      for (const q of line.matchAll(/["']([^"']{1,300})["']/g)) { const n = reqName(q[1]); if (n) out.push({ name: n, dev: arrayDev }); }
      if (line.replace(/["'][^"']*["']/g, '').includes(']')) arrayKey = null;
      continue;
    }
    const h = /^\s*\[([^\]]{1,200})\]\s*$/.exec(line);
    if (h) {
      table = h[1].trim();
      // [dependencies.serde] style tables name one dependency.
      const sub = kind === 'cargo' ? /^(dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9_-]{1,100})$/.exec(table) : null;
      if (sub) out.push({ name: sub[2], dev: sub[1] === 'dev-dependencies' });
      continue;
    }
    if (kind === 'pyproject') {
      const isProjectDeps = table === 'project' && /^\s*dependencies\s*=\s*\[/.test(line);
      const isOptional = table === 'project.optional-dependencies' && /^\s*[A-Za-z0-9_.-]+\s*=\s*\[/.test(line);
      // Extras named for development (dev, test, docs, lint ...) are dev dependencies.
      const devExtra = isOptional && /^\s*["']?(?:dev|develop|development|test|tests|testing|docs?|lint|typing|types|ci|all-dev)["']?\s*=/.test(line);
      const isGroup = table === 'dependency-groups' && /^\s*[A-Za-z0-9_.-]+\s*=\s*\[/.test(line);
      const isUvDev = table === 'tool.uv' && /^\s*dev-dependencies\s*=\s*\[/.test(line);
      if (isProjectDeps || isOptional || isGroup || isUvDev) {
        const after = line.slice(line.indexOf('[') + 1);
        const dev = isGroup || isUvDev || devExtra;
        for (const q of after.matchAll(/["']([^"']{1,300})["']/g)) { const n = reqName(q[1]); if (n) out.push({ name: n, dev }); }
        if (!after.replace(/["'][^"']*["']/g, '').includes(']')) { arrayKey = 'deps'; arrayDev = dev; }
        continue;
      }
    }
    if (prodTables.test(table) || devTables.test(table)) {
      const k = /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]{0,100})["']?\s*(?:\.workspace\s*)?=/.exec(line);
      if (k && !(kind === 'pyproject' && k[1].toLowerCase() === 'python')) out.push({ name: k[1], dev: devTables.test(table) });
    }
  }
  return out;
}

/** Image names of a compose file, normalised (no registry docker.io, no library/, no tag, no digest). */
export function composeImages(text) {
  const out = [];
  // [ \t]* after ^, never \s*: with the m flag, \s* would run over newlines from every line start (R-WB-14).
  for (const m of text.matchAll(/^[ \t]*image[ \t]*:[ \t]*["']?([^\s"'#]{1,300})/gm)) out.push(normImage(m[1]));
  return out;
}

export function normImage(ref) {
  let r = String(ref).toLowerCase().replace(/@sha256:[0-9a-f]{0,64}$/, '');
  const lastSlash = r.lastIndexOf('/');
  const colon = r.lastIndexOf(':');
  if (colon > lastSlash) r = r.slice(0, colon);
  r = r.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '').replace(/^library\//, '');
  return r;
}

// ---------------------------------------------------------------- code

const ENV_CODE_RE = /(?:process\.env\.|Bun\.env\.|import\.meta\.env\.)([A-Z][A-Z0-9_]{1,63})\b|(?:process\.env|os\.environ|Deno\.env\.get|env::var|[Gg]etenv|LookupEnv|GetEnvironmentVariable|environ\.get|getEnv|ENV\.fetch|ENV)\s*[[(]\s*['"`]([A-Z][A-Z0-9_]{1,63})['"`]/g;
const HOST_RE = /\bhttps?:\/\/([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,6})(\/[A-Za-z0-9._~/-]{0,80})?/gi;

/** File writes in code: distinct tokens seen make the filesystem signal (FS_RULE). */
export const FS_TOKENS = Object.freeze([
  ['js_write_file', /\b(?:fs|fsp|promises|fsPromises)\.(?:writeFile|appendFile|mkdir|rm|unlink|rename|cp|copyFile)\s*\(|\b(?:writeFileSync|appendFileSync|mkdirSync|unlinkSync|renameSync|rmSync)\s*\(/],
  ['py_write_file', /\.write_(?:text|bytes)\s*\(|\bopen\s*\([^)\n]{0,200},\s*['"](?:w|a|x|wb|ab|w\+|a\+|r\+)['"]|\bshutil\.(?:move|copy|copy2|copytree|rmtree)\s*\(|\bos\.(?:remove|unlink|makedirs|rename|replace|rmdir)\s*\(/],
  ['go_write_file', /\bos\.(?:WriteFile|Create|Remove|RemoveAll|MkdirAll|Rename)\s*\(/],
  ['rs_write_file', /\b(?:fs|std::fs)::(?:write|create_dir_all|remove_file|rename|copy)\s*\(|\bFile::create\s*\(/],
]);
/** FS_RULE: the filesystem is a backend only when code writes files AND a write-like tool is file-shaped. */
export const FILE_WORDS = new Set(['file', 'files', 'dir', 'dirs', 'directory', 'directories', 'folder', 'folders', 'path', 'paths', 'vault', 'markdown', 'md', 'csv', 'xlsx', 'workbook']);

/** Static tool names: registration calls and decorators in the common SDKs. */
const TOOL_RES = Object.freeze([
  // `server.registerTool('x'`, or a bound `registerTool(\n  'x'` (the name may be on the next line).
  /(?:\.|\b)(?:tool|registerTool|addTool|add_tool|register_tool)\(\s*['"`]([A-Za-z][A-Za-z0-9_.-]{0,63})['"`]/g,
  // A decorator, its arguments on one line or several (FastMCP: `@mcp.tool(\n  name="x",\n  annotations=ToolAnnotations(...),\n)`), bounded.
  /@[\w.]{0,40}tool\b(?:\(([\s\S]{0,800}?)\))?[ \t]*\r?\n(?:[ \t]*@[^\n]{0,200}\r?\n){0,3}[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w{0,63})/g,
  /\bTool\(\s*name\s*=\s*['"]([A-Za-z][A-Za-z0-9_.-]{0,63})['"]/g,
  /\bmcp\.NewTool\(\s*"([A-Za-z][A-Za-z0-9_.-]{0,63})"/g,
  /#\[tool\([^\]\n]{0,300}\)\][\s]{0,200}(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?fn\s+([a-z_]\w{0,63})/g,
  /@Tool\(\s*(?:name\s*=\s*)?"([A-Za-z][A-Za-z0-9_.-]{0,63})"/g,
  /\[McpServerTool\(\s*Name\s*=\s*"([A-Za-z][A-Za-z0-9_.-]{0,63})"/g,
  /\bname:\s*['"`]([a-z][a-z0-9]*(?:[_-][a-z0-9]+){1,6})['"`]\s*,\s*(?:title:\s*['"`][^'"`\n]{0,200}['"`]\s*,\s*)?description:/g,
]);

const WRITE_VERBS = new Set(('create add insert update edit modify patch set put write save upsert delete remove drop destroy purge clear move rename copy upload ' +
  'send post publish submit merge close reopen archive unarchive assign unassign approve reject commit push deploy trigger run execute exec apply import ' +
  'enable disable start stop restart cancel transfer invite revoke grant lock unlock star unstar fork comment reply react like follow unfollow subscribe ' +
  'unsubscribe schedule book order pay refund mark tag untag label pin unpin append replace reset sync install uninstall store remember forget record log ' +
  'mutate alter truncate kill terminate scale rollback revert resolve dismiss mute unmute block unblock ban kick share unshare attach detach link unlink ' +
  'register unregister rotate generate make new duplicate clone checkout branch rebase tick check uncheck complete toggle increment decrement')
  .split(' '));
const READ_VERBS = new Set('get list search find read fetch query describe show view count validate inspect explain analyze analyse status ping help lookup browse retrieve summarize summarise diff compare preview export download watch tail scan stat stats info whoami'.split(' '));

/** The words of a tool name: snake, kebab, dotted and camel case. */
export function toolWords(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.\-\s]+/).filter(Boolean);
}

/** Is this tool name write-like? Any write verb anywhere in it (so `check_out` and `get_log` count: erring towards testing). */
export function writeLike(name) {
  const w = toolWords(name);
  return w.some((x) => WRITE_VERBS.has(x));
}

// ---------------------------------------------------------------- analyzer

const isTestPath = (p) => TEST_PATH_RE.test(`/${p}`);

/** Kinds that are never a backend a server writes data to (a browser or a desktop GUI). */
const notAStore = (b) => b?.not_a_store === true;

export function createAnalyzer({ table, index }) {
  const hits = new Map(); // id -> Map(kind -> {weight, evidence: [{path, detail}]})
  const env = new Map(); // name -> where (code | config | readme)
  const tools = new Set();
  const fsTokens = new Set();
  const specs = []; // {path, version, petstore}
  const unknownApiHosts = new Set(); // api.* hosts in code that no map names (counted, never kept: upstream text)
  let filesRead = 0;
  let codeFilesRead = 0;
  let serverJsonRemote = false;
  let serverJsonPackages = false;

  const hit = (id, kind, weight, path, detail) => {
    if (!table.has(id)) return;
    if (!hits.has(id)) hits.set(id, new Map());
    const m = hits.get(id);
    const cur = m.get(kind) ?? { weight: 0, evidence: [] };
    cur.weight = Math.max(cur.weight, weight);
    if (cur.evidence.length < 3 && !cur.evidence.some((e) => e.path === path && e.detail === detail)) cur.evidence.push({ path, detail });
    m.set(kind, cur);
  };

  const noteEnv = (name, where, path) => {
    if (!keepEnvName(name)) return;
    if (!env.has(name)) env.set(name, where);
    for (const id of index.env.get(name) ?? []) {
      if (where === 'readme') hit(id, 'env_name_readme', WEIGHTS.env_name_readme, path, name);
      else hit(id, 'env_name', WEIGHTS.env_name, path, name);
    }
    const p = index.envPrefix.find(([pre]) => name.startsWith(pre) && name.length > pre.length);
    if (p && !(index.env.get(name) ?? []).includes(p[1])) hit(p[1], 'env_prefix', WEIGHTS.env_prefix, path, name);
  };

  const noteSchemes = (text, path, weight) => {
    if (!index.schemeRe) return;
    index.schemeRe.lastIndex = 0;
    const seen = new Set();
    for (const m of text.matchAll(index.schemeRe)) {
      const s = m[1].toLowerCase();
      if (seen.has(s)) continue;
      seen.add(s);
      for (const id of index.schemes.get(s) ?? []) hit(id, weight === WEIGHTS.url_scheme ? 'url_scheme' : 'url_scheme_readme', weight, path, `${s}://`);
    }
  };

  const noteDep = (eco, name, dev, path) => {
    const w = dev ? WEIGHTS.dev_dependency : WEIGHTS.dependency;
    const kind = dev ? 'dev_dependency' : 'dependency';
    let ids = [];
    if (eco === 'npm') ids = index.npm.get(name.toLowerCase()) ?? [];
    else if (eco === 'pypi') ids = index.pypi.get(normPy(name)) ?? [];
    else if (eco === 'cargo') ids = index.cargo.get(name.toLowerCase()) ?? [];
    else if (eco === 'nuget') ids = index.nuget.get(name.toLowerCase()) ?? [];
    else if (eco === 'maven') ids = index.maven.get(name.toLowerCase()) ?? [];
    else if (eco === 'go') {
      const n = name.toLowerCase();
      const g = index.go.find(([p]) => n === p || n.startsWith(`${p}/`));
      ids = g ? [g[1]] : [];
    }
    for (const id of ids) hit(id, kind, w, path, name);
  };

  function addFile(path, text) {
    if (typeof path !== 'string' || typeof text !== 'string') return;
    const role = fileRole(path);
    if (!role) return;
    filesRead++;
    // Configuration and documentation are read in their first part only, so no scan costs more than a bounded amount
    // (R-WB-14); code has its own caps in the lane, and a spec only its head is looked at.
    if (role !== 'code' && role !== 'maybe_spec') text = text.slice(0, role === 'readme' ? MAX_README_CHARS : MAX_CONFIG_CHARS);
    const test = isTestPath(path);
    if (role === 'manifest') {
      const mk = manifestKind(path);
      if (mk === 'prisma') {
        const at = text.indexOf('datasource');
        const block = at < 0 ? '' : text.slice(at, at + 2000);
        const close = block.indexOf('}');
        const prov = at < 0 ? null : /provider[ \t]*=[ \t]*"([a-z]{1,30})"/.exec(close < 0 ? block : block.slice(0, close));
        if (prov) for (const id of index.prisma.get(prov[1]) ?? []) hit(id, 'prisma_provider', WEIGHTS.prisma_provider, path, prov[1]);
        return;
      }
      const eco = { npm: 'npm', pyproject: 'pypi', requirements: 'pypi', setup_py: 'pypi', setup_cfg: 'pypi', pipfile: 'pypi', gomod: 'go', cargo: 'cargo', pom: 'maven', gradle: 'maven', csproj: 'nuget' }[mk];
      for (const d of manifestDeps(mk, text)) noteDep(eco, d.name, d.dev || test, path);
      return;
    }
    if (role === 'compose') {
      for (const img of composeImages(text)) {
        for (const [entry, ids] of index.images) {
          if (img === entry || (entry.includes('/') && img.endsWith(`/${entry}`))) for (const id of ids) hit(id, 'compose_image', test ? WEIGHTS.dev_dependency : WEIGHTS.compose_image, path, entry);
        }
      }
      for (const m of text.matchAll(/^[ \t]*-?[ \t]*([A-Z][A-Z0-9_]{1,63})[ \t]*[:=]/gm)) noteEnv(m[1], 'config', path);
      noteSchemes(text, path, WEIGHTS.url_scheme);
      return;
    }
    if (role === 'env_example') {
      for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]{1,63})[ \t]*=/gm)) noteEnv(m[1], 'config', path);
      noteSchemes(text, path, WEIGHTS.url_scheme);
      return;
    }
    if (role === 'server_json' || role === 'mcpb_manifest') {
      let doc;
      try { doc = JSON.parse(text); } catch { return; }
      if (role === 'server_json') {
        const pk = Array.isArray(doc?.packages) ? doc.packages : [];
        if (pk.length) serverJsonPackages = true;
        if (Array.isArray(doc?.remotes) && doc.remotes.length) serverJsonRemote = true;
        for (const p of pk) for (const e of Array.isArray(p?.environmentVariables) ? p.environmentVariables : []) if (typeof e?.name === 'string') noteEnv(e.name, 'config', path);
      } else {
        const envs = doc?.server?.mcp_config?.env;
        if (envs && typeof envs === 'object' && !Array.isArray(envs)) for (const k of Object.keys(envs)) noteEnv(k, 'config', path);
      }
      return;
    }
    if (role === 'readme') {
      for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,30}(?:_[A-Z0-9]{1,30}){1,6})\b/g)) if (README_ENV_RE.test(m[1])) noteEnv(m[1], 'readme', path);
      noteSchemes(text, path, WEIGHTS.url_scheme_readme);
      return;
    }
    if (role === 'maybe_spec') {
      const head = text.slice(0, 4096);
      const m = /["']?(openapi|swagger)["']?\s*:\s*["']?(3\.[0-9.]{1,6}|2\.0)/.exec(head);
      if (!m || (!SPEC_NAME_RE.test(path) && !/^\s*[{]?\s*["']?(?:openapi|swagger)["']?\s*:/m.test(head))) return;
      if (SAMPLE_PATH_RE.test(`/${path}`)) return;
      // The Swagger sample (Petstore) ships with generic OpenAPI-to-MCP tools; it is not the server's backend.
      const petstore = /petstore/i.test(text.slice(0, 8192));
      specs.push({ path, version: m[2], petstore });
      return;
    }
    if (role === 'code') {
      codeFilesRead++;
      ENV_CODE_RE.lastIndex = 0;
      for (const m of text.matchAll(ENV_CODE_RE)) noteEnv(m[1] ?? m[2], 'code', path);
      noteSchemes(text, path, test ? WEIGHTS.dev_dependency : WEIGHTS.url_scheme);
      if (index.codeRe) {
        index.codeRe.lastIndex = 0;
        const seen = new Set();
        for (const m of text.matchAll(index.codeRe)) {
          if (seen.has(m[0])) continue;
          seen.add(m[0]);
          for (const id of index.code.get(m[0]) ?? []) hit(id, test ? 'code_token_test' : 'code_token', test ? WEIGHTS.code_token_test : WEIGHTS.code_token, path, m[0]);
        }
      }
      HOST_RE.lastIndex = 0;
      const hostsSeen = new Set();
      for (const m of text.matchAll(HOST_RE)) {
        const host = m[1].toLowerCase();
        const p = m[2] ?? '';
        const key = `${host}${p.slice(0, 20)}`;
        if (hostsSeen.has(key)) continue;
        hostsSeen.add(key);
        let known = false;
        for (const h of index.hosts) {
          if ((host === h.host || host.endsWith(`.${h.host}`)) && (h.path === '' || p.startsWith(h.path))) {
            known = true;
            hit(h.id, test ? 'host_literal_test' : 'host_literal', test ? WEIGHTS.host_literal_test : WEIGHTS.host_literal, path, h.path ? `${h.host}${h.path}` : h.host);
          }
        }
        if (!known && !test && /^api\./.test(host) && !/(?:^|\.)(?:localhost|example\.(?:com|org|net)|github\.com|githubusercontent\.com)$/.test(host)) unknownApiHosts.add(host);
      }
      if (!test) for (const [id, re] of FS_TOKENS) if (re.test(text)) fsTokens.add(id);
      if (!test && tools.size < MAX_TOOL_NAMES) {
        for (const re of TOOL_RES) {
          re.lastIndex = 0;
          for (const m of text.matchAll(re)) {
            let name = m[1] && m[2] === undefined ? m[1] : null;
            if (m[2] !== undefined) {
              // Python decorators: name="x" in the arguments, else the function's name.
              const named = m[1] ? /\bname\s*=\s*['"]([A-Za-z][A-Za-z0-9_.-]{0,63})['"]/.exec(m[1]) : null;
              name = named ? named[1] : m[2];
            }
            if (name && tools.size < MAX_TOOL_NAMES) tools.add(name);
          }
        }
      }
    }
  }

  function result({ repo = null, commit = null, source = 'archive', truncated = false, mapVersions = null } = {}) {
    const toolList = [...tools].sort();
    const writeTools = toolList.filter(writeLike);
    // FS_RULE (above): file writes in code plus a file-shaped write tool.
    if (fsTokens.size > 0) {
      const fileTools = writeTools.filter((t) => toolWords(t).some((w) => FILE_WORDS.has(w)));
      hit('filesystem', 'fs_write', WEIGHTS.fs_write, null, [...fsTokens].sort().join(','));
      if (fileTools.length > 0) hit('filesystem', 'tool_names', 2, null, fileTools.slice(0, 3).join(','));
    }
    const scored = [];
    for (const [id, kinds] of hits) {
      const b = table.get(id);
      let score = 0;
      const signals = [];
      for (const [k, v] of kinds) { score += v.weight; signals.push(k); }
      scored.push({ id, b, score, signals: signals.sort(), kinds });
    }
    const routeRank = (b) => (usableStandIn(b) ? 0 : b.spec ? 1 : 2);
    // A backend the repository declares (a dependency, a compose image, a Prisma provider) or calls by name (a code
    // token, an API host) ranks above one it only mentions (a URL scheme, an env name): a secret scanner's
    // `postgres://` pattern does not make a SQLite server a Postgres one (R-WB-18).
    const anchored = (s) => s.signals.some((k) => ANCHOR_SIGNALS.has(k));
    scored.sort((x, y) => (anchored(y) - anchored(x)) || y.score - x.score || routeRank(x.b) - routeRank(y.b) || (x.id < y.id ? -1 : 1));
    // The generic SQL entry stands aside when a specific engine is found.
    const specificSql = scored.some((s) => s.id !== 'sql' && s.b.kind === 'sql' && s.score >= FOUND_SCORE);
    const strong = (s) => s.signals.some((k) => STRONG_SIGNALS.has(k) || (k === 'env_name' && s.b.kind === 'hosted_api'));
    const found0 = scored.filter((s) => s.score >= FOUND_SCORE && strong(s) && !(s.id === 'sql' && specificSql));
    // The filesystem is a fallback: a server whose writes go to a store we name is that store's, whatever its files (FS_RULE).
    const found = [...found0.filter((s) => s.id !== 'filesystem'), ...found0.filter((s) => s.id === 'filesystem')];
    const primary = found[0] ?? null;
    const backends = scored.slice(0, 12).map((s) => ({
      id: s.id, kind: s.b.kind, score: s.score, signals: s.signals,
      role: s === primary ? 'primary' : found.includes(s) ? 'secondary' : 'candidate',
    }));

    const evidence = [];
    for (const s of scored) {
      for (const [k, v] of [...s.kinds].sort((a, b) => b[1].weight - a[1].weight)) {
        for (const e of v.evidence) if (evidence.length < MAX_EVIDENCE) evidence.push({ signal: k, backend: s.id, path: e.path, detail: e.detail });
      }
    }
    const realSpecs = specs.filter((x) => !x.petstore);
    for (const x of realSpecs.slice(0, 3)) if (evidence.length < MAX_EVIDENCE) evidence.push({ signal: 'openapi_file', backend: null, path: x.path, detail: `${/^2/.test(x.version) ? 'swagger' : 'openapi'} ${x.version}` });
    if (toolList.length && evidence.length < MAX_EVIDENCE) evidence.push({ signal: 'tool_names', backend: null, path: null, detail: `${writeTools.length} of ${toolList.length} write-like` });

    const envNames = [...env.keys()].sort();
    const baseUrlEnv = envNames.filter((n) => BASE_URL_ENV_RE.test(n) && !/(?:TOKEN|KEY|SECRET|PASSWORD)/.test(n));
    const envOut = [...baseUrlEnv, ...envNames.filter((n) => !baseUrlEnv.includes(n))].slice(0, MAX_ENV_NAMES);

    // The repository's own description: the shortest path, then the first by name (a stable pick, whatever the tar order).
    const repoSpec = realSpecs.length && commit && repo ? [...realSpecs].sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : 1))[0] : null;
    const repoSpecUrl = repoSpec ? `https://raw.githubusercontent.com/${repo}/${commit}/${repoSpec.path.split('/').map(encodeURIComponent).join('/')}` : null;
    const repoSpecFormat = repoSpec ? (/^2/.test(repoSpec.version) ? 'swagger2' : 'openapi3') : null;

    let cls;
    let reason = null;
    let standIn = null;
    let specUrl = null;
    let specFormat = null;
    let conf;
    const confOf = (s) => (s.score >= HIGH_SCORE && s.signals.length >= 2 ? 'high' : s.score >= FOUND_SCORE ? 'medium' : 'low');
    if (toolList.length >= MIN_TOOLS_FOR_READ_ONLY && writeTools.length === 0) {
      cls = 'none';
      reason = 'no_write_tools_seen';
      conf = toolList.length >= 5 ? 'medium' : 'low';
    } else if (!primary) {
      const apiKeyEnv = envNames.some((n) => HOSTED_KEY_ENV_RE.test(n));
      if (repoSpecUrl) {
        cls = 'mock_min'; specUrl = repoSpecUrl; specFormat = repoSpecFormat; conf = realSpecs.length === 1 ? 'medium' : 'low';
      } else if (unknownApiHosts.size > 0 && apiKeyEnv) {
        // An API host no map names, and a key for it: a hosted service we hold no description for.
        cls = 'none'; reason = 'hosted_without_spec'; conf = 'low';
        if (evidence.length < MAX_EVIDENCE) evidence.push({ signal: 'host_literal', backend: null, path: null, detail: `${unknownApiHosts.size} API host(s) no map names` });
      } else {
        cls = 'none'; reason = 'no_backend_signal'; conf = truncated || source !== 'archive' ? 'low' : 'medium';
      }
    } else {
      const b = primary.b;
      conf = confOf(primary);
      if (notAStore(b)) { cls = 'none'; reason = 'not_a_store'; }
      else if (usableStandIn(b)) { cls = 'local_full'; standIn = { id: b.stand_in.id, product: b.stand_in.product, fidelity: b.stand_in.fidelity }; }
      else if (b.spec) { cls = 'mock_min'; specUrl = b.spec.url; specFormat = b.spec.format; }
      else if (repoSpecUrl) { cls = 'mock_min'; specUrl = repoSpecUrl; specFormat = repoSpecFormat; conf = 'low'; }
      else {
        cls = 'none';
        reason = b.stand_in && b.stand_in.cleared === false && (b.stand_in.fidelity === 'real' || b.stand_in.fidelity === 'faithful') ? 'stand_in_not_cleared'
          : b.kind === 'hosted_api' || !b.stand_in ? 'hosted_without_spec' : 'no_stand_in';
      }
      if (primary.id === 'sql' && conf === 'high') conf = 'medium';
      // Two backends with the same score and different modes: we cannot tell which the write tools use.
      const rival = found[1];
      const modeOfB = (x) => (notAStore(x) ? 'none' : usableStandIn(x) ? 'full' : x.spec ? 'min' : 'none');
      if (rival && rival.score === primary.score && modeOfB(rival.b) !== modeOfB(b)) conf = 'low';
    }
    if (source !== 'archive' && conf === 'high') conf = 'medium';
    return {
      class: cls,
      mode: MODE_OF[cls],
      reason,
      backend: primary ? { id: primary.id, kind: primary.b.kind } : cls === 'mock_min' ? { id: 'repo-openapi', kind: 'hosted_api' } : null,
      backends,
      stand_in: standIn,
      spec_url: specUrl,
      spec_format: specFormat,
      env_names: envOut,
      base_url_env: baseUrlEnv.slice(0, MAX_ENV_NAMES),
      confidence: conf,
      evidence,
      write_tools: { names_seen: toolList.length, write_like: writeTools.length, sample: [...writeTools.slice(0, MAX_TOOL_SAMPLE / 2), ...toolList.filter((t) => !writeLike(t)).slice(0, MAX_TOOL_SAMPLE / 2)] },
      basis: {
        source, commit, files_read: filesRead, code_files_read: codeFilesRead, truncated: Boolean(truncated),
        server_json: serverJsonPackages || serverJsonRemote ? { packages: serverJsonPackages, remotes: serverJsonRemote } : null,
        scan_version: SCAN_VERSION, maps: mapVersions,
      },
    };
  }

  return { addFile, result, get filesRead() { return filesRead; } };
}

// ---------------------------------------------------------------- map checks

const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** A spec URL: https, a host, a path, no port, user, password, query or fragment (the dispatch input contract). */
const HTTPS_RE = /^https:\/\/[a-z0-9.-]+\/[^\s?#@]*$/i;

/** Problems with the two data files (empty when fine). */
export function mapProblems(standIns, specUrls) {
  const p = [];
  if (!Number.isInteger(standIns?.version) || standIns.version < 1) p.push('stand-ins.json: version must be a positive integer');
  if (!Number.isInteger(specUrls?.version) || specUrls.version < 1) p.push('spec-urls.json: version must be a positive integer');
  const checkSignals = (where, s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) { p.push(`${where}: signals must be an object`); return; }
    for (const [k, v] of Object.entries(s)) {
      if (!SIGNAL_KEYS.includes(k)) p.push(`${where}: unknown signal key ${k}`);
      else if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0 || x.length > 200)) p.push(`${where}.${k}: must be a list of non-empty strings`);
    }
    for (const n of s.env ?? []) if (!keepEnvName(n)) p.push(`${where}.env: ${n} is not an env var name we keep (ENV_DENY_RE)`);
    for (const n of s.env_prefix ?? []) if (!/^[A-Z][A-Z0-9_]{0,30}_$/.test(n)) p.push(`${where}.env_prefix: ${n} must end in _`);
    for (const n of s.url_schemes ?? []) if (!/^[a-z][a-z0-9+]{0,20}$/.test(n) || n === 'http' || n === 'https') p.push(`${where}.url_schemes: ${n}`);
    for (const n of s.hosts ?? []) if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[A-Za-z0-9._~/-]*)?$/.test(n)) p.push(`${where}.hosts: ${n}`);
  };
  for (const [id, b] of Object.entries(standIns?.backends ?? {})) {
    const w = `stand-ins.json ${id}`;
    if (!ID_RE.test(id)) p.push(`${w}: id must match ${ID_RE}`);
    if (!KINDS.includes(b?.kind)) p.push(`${w}: kind must be one of ${KINDS.join(', ')}`);
    if (b.stand_in !== null) {
      const s = b.stand_in;
      if (!s || typeof s !== 'object') { p.push(`${w}: stand_in must be an object or null`); continue; }
      if (!ID_RE.test(String(s.id))) p.push(`${w}: stand_in.id`);
      if (typeof s.product !== 'string' || !s.product) p.push(`${w}: stand_in.product`);
      if (!FIDELITIES.includes(s.fidelity)) p.push(`${w}: stand_in.fidelity must be one of ${FIDELITIES.join(', ')}`);
      if (typeof s.cleared !== 'boolean') p.push(`${w}: stand_in.cleared must be true or false`);
    } else if (b.not_a_store !== true && !Object.hasOwn(specUrls?.services ?? {}, id)) p.push(`${w}: a backend with no stand-in must say not_a_store, or have a spec in spec-urls.json`);
    checkSignals(w, b.signals);
  }
  for (const [id, s] of Object.entries(specUrls?.services ?? {})) {
    const w = `spec-urls.json ${id}`;
    if (!ID_RE.test(id)) p.push(`${w}: id must match ${ID_RE}`);
    if (typeof s?.name !== 'string' || !s.name) p.push(`${w}: name`);
    checkSignals(w, s?.signals);
    // A known hosted API with no published description: spec null, and a note saying what was looked for and when.
    if (s?.spec === null) {
      if (typeof s.note !== 'string' || !/\d{4}-\d{2}-\d{2}/.test(s.note)) p.push(`${w}: spec null needs a note with the date it was looked for`);
      continue;
    }
    if (!s?.spec || !HTTPS_RE.test(String(s.spec.url)) || String(s.spec.url).length > 512) p.push(`${w}: spec.url must be an https URL of at most 512 characters, with no port, user, password, query or fragment`);
    if (!SPEC_FORMATS.includes(s?.spec?.format)) p.push(`${w}: spec.format must be one of ${SPEC_FORMATS.join(', ')}`);
    if (s?.spec?.publisher !== 'vendor') p.push(`${w}: spec.publisher must be vendor (only the service's own description counts)`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s?.spec?.checked))) p.push(`${w}: spec.checked must be a date`);
  }
  return p;
}
