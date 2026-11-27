// An in-memory GitHub for the chaos suite: the REST calls the pump, ingest,
// the successor, the watchdog, the state asset, the snapshots and the restore
// drill make, served from memory at fetch level. Nothing here touches the
// network: every host (api, uploads, blob storage) is answered by `fetch`.
//
//   const gh = new FakeGitHub({ now: () => sim.t });
//   gh.addRepo('chaos-sim/tool-qa'); gh.addRepo('chaos-sim/worker');
//   await runSomething({ fetch: gh.fetch });
//
// What it models:
//   releases and assets   tags, upload (uploads host), download (302 to blob
//                         storage), rename (PATCH), delete; ids only grow and
//                         every change moves updated_at
//   actions               workflow_dispatch (with return_run_details), runs and
//                         their filters (event, created, status), run artifacts,
//                         artifact downloads (302 to blob storage), the
//                         workflow list and enable, the repository artifact list;
//                         a workflow given `inputs` refuses any other (422)
//   branches              GET /branches/{ref}
//   commits               GET /commits/{sha}: an abbreviated SHA to the full
//                         one among the repository's known commits
//   variables             environment and repository variables, org variables
//   issues                list, create, edit, comment; /graphql pinIssue
//   public repositories   the subjects' repositories as /graphql answers them
//                         to the pump's id lookups (pump/identity.mjs):
//                         repository(owner, name) follows renames and
//                         transfers as GitHub does; nodes(ids) by node id; a
//                         deleted or private one is NOT_FOUND
//
// Faults: addFault({ name, match(req), times, mode, respond }) where mode is
//   'refuse'   answer with respond(req) and do nothing (a 5xx, a 403/429)
//   'lie'      do the request, then answer with respond(req) instead (a
//              dispatch that ran but answered 502; a push that landed but
//              answered 500)
//   'swallow'  answer as if done (respond(req) or the normal answer) but do
//              nothing (a dispatch GitHub dropped)
//   'duplicate' do the request twice and answer with the first answer
// `times` (default 1) counts matches. Every request is kept in `calls`.
//
// Hooks: onDispatch(repo, file, run, inputs) is called for every run a
// dispatch creates; onCancel(repo, run) for a run cancelled through the API
// (default: it completes as cancelled); onChange() after every request that
// changed something.

export const API_HOST = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
const OBJECTS = 'https://objects.chaos.test';

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function respond(out) {
  if (out instanceof Response) return out;
  const { status = 200, body, headers = {} } = out ?? {};
  const h = new Headers({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '9999999999', ...headers });
  let payload = null;
  if (status !== 204 && status !== 304 && body !== undefined) {
    if (typeof body === 'string' || body instanceof Uint8Array) payload = body;
    else {
      payload = JSON.stringify(body);
      h.set('content-type', 'application/json');
    }
  }
  return new Response(payload, { status, headers: h });
}

const notFound = () => ({ status: 404, body: { message: 'Not Found' } });

export class FakeGitHub {
  constructor({ now, log = () => {} } = {}) {
    this.now = now ?? (() => Date.now());
    this.log = log;
    this.nextId = 5000;
    this.repos = new Map();
    this.blobs = new Map(); // asset or artifact key -> Buffer
    this.calls = [];
    this.faults = [];
    this.hooks = { onDispatch: null, onCancel: null, onChange: null };
    this.publicRepos = []; // {databaseId, nodeId, name, createdAt, visible, oldNames: Set}
    this.fetch = this.fetch.bind(this);
  }

  // ---- public repositories (the subjects) ----

  addPublicRepo(name, { databaseId, nodeId = `R_chaos${databaseId}`, createdAt = '2025-01-01T00:00:00Z' } = {}) {
    const r = { databaseId, nodeId, name, createdAt, visible: true, oldNames: new Set() };
    this.publicRepos.push(r);
    return r;
  }

  publicRepo(name) {
    const lower = String(name).toLowerCase();
    return this.publicRepos.find((r) => r.name.toLowerCase() === lower) ?? null;
  }

  /** Rename or transfer: the old name keeps redirecting, as on GitHub, until another repository takes it. */
  renamePublicRepo(from, to) {
    const r = this.publicRepo(from);
    if (!r) throw new Error(`fake github: no public repo ${from}`);
    r.oldNames.add(r.name.toLowerCase());
    r.name = to;
    return r;
  }

  /** What repository(owner, name) answers: the visible repository with that name, else one that had it. */
  lookupPublicName(name) {
    const lower = String(name).toLowerCase();
    const live = this.publicRepos.filter((r) => r.visible);
    return live.find((r) => r.name.toLowerCase() === lower) ?? live.find((r) => r.oldNames.has(lower)) ?? null;
  }

  graphqlIdentity(req) {
    const q = String(req.json?.query ?? '');
    const vars = req.json?.variables ?? {};
    const node = (r) => ({ __typename: 'Repository', databaseId: r.databaseId, id: r.nodeId, nameWithOwner: r.name, createdAt: r.createdAt });
    const data = { rateLimit: { cost: 1, remaining: 4999 } };
    const errors = [];
    if (/nodes\(ids:/.test(q)) {
      data.nodes = (vars.ids ?? []).map((id, i) => {
        const r = this.publicRepos.find((x) => x.visible && x.nodeId === id);
        if (!r) errors.push({ type: 'NOT_FOUND', path: ['nodes', i], message: `Could not resolve to a node with the global id of '${id}'` });
        return r ? node(r) : null;
      });
    } else {
      for (let i = 0; vars[`o${i}`] !== undefined; i++) {
        const r = this.lookupPublicName(`${vars[`o${i}`]}/${vars[`n${i}`]}`);
        data[`r${i}`] = r ? node(r) : null;
        if (!r) errors.push({ type: 'NOT_FOUND', path: [`r${i}`], message: 'Could not resolve to a Repository' });
      }
    }
    return { body: errors.length ? { data, errors } : { data } };
  }

  id() {
    this.nextId += 1;
    return this.nextId;
  }

  addRepo(fullName, { branches = { main: '1'.repeat(40) }, workflows = [] } = {}) {
    const r = {
      fullName,
      branches: { ...branches },
      commits: new Set(Object.values(branches)), // every commit GET /commits/{sha} knows (R-PIN-01)
      workflows: new Map(),
      runs: [],
      artifacts: [],
      releases: new Map(),
      variables: {},
      envVariables: {},
      issues: [],
      comments: [],
      extraArtifacts: () => [],
    };
    this.repos.set(fullName, r);
    for (const w of workflows) this.addWorkflow(fullName, w);
    return r;
  }

  repo(fullName) {
    const r = this.repos.get(fullName);
    if (!r) throw new Error(`fake github: no repo ${fullName}`);
    return r;
  }

  addWorkflow(fullName, file, { state = 'active', inputs = null } = {}) {
    const r = this.repo(fullName);
    // inputs: the workflow_dispatch inputs it declares; GitHub refuses a dispatch with any other (422). null: any.
    const w = { id: this.id(), name: file.replace(/\.ya?ml$/, ''), path: `.github/workflows/${file}`, state, inputs };
    r.workflows.set(file, w);
    return w;
  }

  // ---- runs ----

  createRun(fullName, file, { event = 'workflow_dispatch', title, ref = 'main' } = {}) {
    const r = this.repo(fullName);
    const w = r.workflows.get(file) ?? this.addWorkflow(fullName, file);
    const id = this.id();
    const t = iso(this.now());
    const run = {
      id,
      name: title ?? w.name,
      display_title: title ?? w.name,
      event,
      status: 'queued',
      conclusion: null,
      path: w.path,
      workflow_id: w.id,
      head_branch: ref,
      head_sha: r.branches[ref] ?? null,
      run_attempt: 1,
      run_number: r.runs.length + 1,
      created_at: t,
      run_started_at: null,
      updated_at: t,
      html_url: `https://github.com/${fullName}/actions/runs/${id}`,
      repository: { full_name: fullName },
    };
    r.runs.push(run);
    return run;
  }

  findRun(id) {
    for (const r of this.repos.values()) {
      const run = r.runs.find((x) => x.id === Number(id));
      if (run) return { repo: r, run };
    }
    return null;
  }

  startRun(run) {
    run.status = 'in_progress';
    run.run_started_at = iso(this.now());
    run.updated_at = run.run_started_at;
  }

  finishRun(run, conclusion = 'success') {
    run.status = 'completed';
    run.conclusion = conclusion;
    run.updated_at = iso(this.now());
  }

  uploadArtifact(fullName, run, name, data) {
    const r = this.repo(fullName);
    const a = {
      id: this.id(),
      name,
      size_in_bytes: data.length,
      expired: false,
      created_at: iso(this.now()),
      updated_at: iso(this.now()),
      workflow_run: { id: run.id, head_sha: run.head_sha },
    };
    this.blobs.set(`artifact:${a.id}`, Buffer.from(data));
    r.artifacts.push(a);
    return a;
  }

  // ---- releases ----

  release(fullName, tag, { create = false } = {}) {
    const r = this.repo(fullName);
    if (!r.releases.has(tag)) {
      if (!create) return null;
      const id = this.id();
      r.releases.set(tag, { id, tag_name: tag, name: tag, prerelease: true, upload_url: `${UPLOADS}/repos/${fullName}/releases/${id}/assets{?name,label}`, assets: [] });
    }
    return r.releases.get(tag);
  }

  addAsset(fullName, tag, name, data, label = '') {
    const rel = this.release(fullName, tag, { create: true });
    const t = iso(this.now());
    const a = { id: this.id(), name, label, size: data.length, state: 'uploaded', content_type: 'application/octet-stream', created_at: t, updated_at: t };
    this.blobs.set(`asset:${a.id}`, Buffer.from(data));
    rel.assets.push(a);
    return a;
  }

  findAsset(id) {
    for (const r of this.repos.values()) {
      for (const rel of r.releases.values()) {
        const a = rel.assets.find((x) => x.id === Number(id));
        if (a) return { repo: r, rel, a };
      }
    }
    return null;
  }

  assetBytes(id) {
    return this.blobs.get(`asset:${id}`) ?? null;
  }

  /** Replace an asset's bytes in place (corruption), keeping or changing its label. */
  corruptAsset(id, data, { label } = {}) {
    const f = this.findAsset(id);
    this.blobs.set(`asset:${id}`, Buffer.from(data));
    f.a.size = data.length;
    if (label !== undefined) f.a.label = label;
    f.a.updated_at = iso(this.now() + 1);
  }

  // ---- faults ----

  addFault({ name = 'fault', match, times = 1, mode = 'refuse', respond: out } = {}) {
    const f = { name, match, left: times, mode, respond: out, hits: 0 };
    this.faults.push(f);
    return f;
  }

  clearFaults() {
    this.faults = [];
  }

  // ---- fetch ----

  async fetch(input, init = {}) {
    const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? {});
    let body = init.body ?? null;
    let raw = null;
    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      raw = Buffer.from(body);
      body = null;
    }
    let json;
    if (typeof body === 'string') {
      try { json = JSON.parse(body); } catch { json = undefined; }
    }
    const req = { method, url: url.href, host: url.origin, path: url.pathname, query: url.searchParams, headers, json, raw, at: this.now() };
    this.calls.push(req);
    const fault = this.faults.find((f) => f.left > 0 && f.match(req));
    if (fault) {
      fault.left -= 1;
      fault.hits += 1;
      req.fault = fault.name;
      if (fault.mode === 'refuse') return respond(fault.respond ? fault.respond(req) : { status: 502, body: { message: 'Bad Gateway' } });
      if (fault.mode === 'hang') return new Promise(() => {});
      if (fault.mode === 'swallow') {
        return respond(fault.respond ? fault.respond(req) : { status: 204 });
      }
      if (fault.mode === 'duplicate') {
        const first = this.route(req);
        this.route(req);
        this.changed();
        return respond(first);
      }
      if (fault.mode === 'lie') {
        this.route(req);
        this.changed();
        return respond(fault.respond ? fault.respond(req) : { status: 502, body: { message: 'Bad Gateway' } });
      }
    }
    const out = this.route(req);
    if (method !== 'GET') this.changed();
    return respond(out);
  }

  changed() {
    if (this.hooks.onChange) this.hooks.onChange();
  }

  route(req) {
    const { method, path, host } = req;
    let m;
    if (host === OBJECTS) {
      if ((m = /^\/(asset|artifact)\/(\d+)$/.exec(path))) {
        const b = this.blobs.get(`${m[1]}:${m[2]}`);
        return b ? { body: new Uint8Array(b) } : notFound();
      }
      return notFound();
    }
    if (host === UPLOADS) {
      if (method === 'POST' && (m = /^\/repos\/([^/]+\/[^/]+)\/releases\/(\d+)\/assets$/.exec(path))) {
        const r = this.repo(m[1]);
        const rel = [...r.releases.values()].find((x) => x.id === Number(m[2]));
        if (!rel) return notFound();
        const name = req.query.get('name');
        if (rel.assets.some((a) => a.name === name)) return { status: 422, body: { message: 'Validation Failed', errors: [{ code: 'already_exists' }] } };
        const a = this.addAsset(m[1], rel.tag_name, name, req.raw ?? Buffer.alloc(0), req.query.get('label') ?? '');
        return { status: 201, body: { ...a } };
      }
      return notFound();
    }
    if (method === 'POST' && path === '/graphql') {
      if (/pinIssue/.test(String(req.json?.query ?? ''))) return { body: { data: { pinIssue: { issue: { number: 1 } } } } };
      return this.graphqlIdentity(req);
    }
    m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    if (!m) return notFound();
    const r = this.repos.get(m[1]);
    if (!r) return notFound();
    const rest = m[2] ?? '';
    return this.repoRoute(req, r, rest);
  }

  repoRoute(req, r, rest) {
    const { method, query } = req;
    let m;
    // releases
    if (method === 'GET' && (m = /^\/releases\/tags\/([^/]+)$/.exec(rest))) {
      const rel = r.releases.get(decodeURIComponent(m[1]));
      return rel ? { body: { ...rel, assets: rel.assets.map((a) => ({ ...a })) } } : notFound();
    }
    if (method === 'POST' && rest === '/releases') {
      const tag = req.json?.tag_name;
      if (r.releases.has(tag)) return { status: 422, body: { message: 'Validation Failed', errors: [{ code: 'already_exists' }] } };
      const rel = this.release(r.fullName, tag, { create: true });
      return { status: 201, body: { ...rel, assets: [] } };
    }
    if (method === 'GET' && (m = /^\/releases\/(\d+)\/assets$/.exec(rest))) {
      const rel = [...r.releases.values()].find((x) => x.id === Number(m[1]));
      if (!rel) return notFound();
      const page = Number(query.get('page') ?? 1);
      const per = Number(query.get('per_page') ?? 30);
      return { body: rel.assets.slice((page - 1) * per, page * per).map((a) => ({ ...a })) };
    }
    if ((m = /^\/releases\/assets\/(\d+)$/.exec(rest))) {
      const f = this.findAsset(m[1]);
      if (method === 'GET') {
        if (!f) return notFound();
        if (/octet-stream/.test(req.headers.get('accept') ?? '')) return { status: 302, headers: { location: `${OBJECTS}/asset/${f.a.id}` } };
        return { body: { ...f.a } };
      }
      if (method === 'DELETE') {
        if (!f) return notFound();
        f.rel.assets = f.rel.assets.filter((a) => a.id !== f.a.id);
        this.blobs.delete(`asset:${f.a.id}`);
        return { status: 204 };
      }
      if (method === 'PATCH') {
        if (!f) return notFound();
        const name = req.json?.name;
        if (name && name !== f.a.name && f.rel.assets.some((a) => a.name === name)) return { status: 422, body: { message: 'Validation Failed', errors: [{ code: 'already_exists' }] } };
        if (name) f.a.name = name;
        if (req.json?.label !== undefined) f.a.label = req.json.label;
        f.a.updated_at = iso(this.now());
        return { body: { ...f.a } };
      }
    }
    // commits (R-PIN-01): an abbreviated SHA resolves to the one known commit it starts; none 404, several 422
    if (method === 'GET' && (m = /^\/commits\/([0-9a-f]{4,40})$/.exec(rest))) {
      const hits = [...r.commits].filter((c) => c.startsWith(m[1]));
      if (hits.length === 0) return notFound();
      if (hits.length > 1) return { status: 422, body: { message: `The SHA ${m[1]} is ambiguous` } };
      return { body: { sha: hits[0] } };
    }
    // branches
    if (method === 'GET' && (m = /^\/branches\/([^/]+)$/.exec(rest))) {
      const sha = r.branches[decodeURIComponent(m[1])];
      return sha ? { body: { name: decodeURIComponent(m[1]), commit: { sha } } } : notFound();
    }
    // actions: workflows
    if (method === 'GET' && rest === '/actions/workflows') {
      const all = [...r.workflows.values()].map((w) => ({ ...w }));
      return { body: { total_count: all.length, workflows: all } };
    }
    // one workflow file's state (the watchdog's external-workflows item): the simulated one's, else active
    if (method === 'GET' && (m = /^\/actions\/workflows\/([^/]+\.ya?ml)$/.exec(rest))) {
      return { body: { state: r.workflows.get(decodeURIComponent(m[1]))?.state ?? 'active' } };
    }
    if (method === 'PUT' && (m = /^\/actions\/workflows\/(\d+)\/enable$/.exec(rest))) {
      const w = [...r.workflows.values()].find((x) => x.id === Number(m[1]));
      if (!w) return notFound();
      w.state = 'active';
      return { status: 204 };
    }
    if (method === 'POST' && (m = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest))) {
      const file = decodeURIComponent(m[1]);
      const w = r.workflows.get(file);
      if (!w) return notFound();
      if (w.state !== 'active') return { status: 422, body: { message: 'Workflow does not have \'workflow_dispatch\' trigger, or is disabled' } };
      const ref = req.json?.ref ?? 'main';
      if (!r.branches[ref]) return { status: 422, body: { message: `No ref found for: ${ref}` } };
      const inputs = req.json?.inputs ?? {};
      const unexpected = Array.isArray(w.inputs) ? Object.keys(inputs).filter((k) => !w.inputs.includes(k)) : [];
      if (unexpected.length) return { status: 422, body: { message: `Unexpected inputs provided: ${JSON.stringify(unexpected)}` } };
      const title = inputs.shard_id ? `shard ${inputs.shard_id}` : undefined;
      const run = this.createRun(r.fullName, file, { event: 'workflow_dispatch', title, ref });
      run.inputs = inputs;
      if (this.hooks.onDispatch) this.hooks.onDispatch(r.fullName, file, run, inputs);
      if (req.json?.return_run_details) return { status: 200, body: { workflow_run_id: run.id, run_url: `${API_HOST}/repos/${r.fullName}/actions/runs/${run.id}`, html_url: run.html_url } };
      return { status: 204 };
    }
    if (method === 'GET' && (m = /^\/actions\/workflows\/([^/]+)\/runs$/.exec(rest))) {
      const file = decodeURIComponent(m[1]);
      const w = r.workflows.get(file);
      if (!w) return notFound();
      let list = r.runs.filter((x) => x.workflow_id === w.id);
      const event = query.get('event');
      if (event) list = list.filter((x) => x.event === event);
      const status = query.get('status');
      if (status) list = list.filter((x) => (status === 'completed' ? x.status === 'completed' : x.status === status));
      const created = query.get('created');
      if (created && created.startsWith('>=')) {
        const since = Date.parse(created.slice(2));
        list = list.filter((x) => Date.parse(x.created_at) >= since);
      }
      list = [...list].sort((a, b) => b.id - a.id);
      const per = Number(query.get('per_page') ?? 30);
      const page = Number(query.get('page') ?? 1);
      return { body: { total_count: list.length, workflow_runs: list.slice((page - 1) * per, page * per).map((x) => ({ ...x })) } };
    }
    // actions: runs
    if (method === 'GET' && (m = /^\/actions\/runs\/(\d+)$/.exec(rest))) {
      const run = r.runs.find((x) => x.id === Number(m[1]));
      return run ? { body: { ...run } } : notFound();
    }
    if (method === 'POST' && (m = /^\/actions\/runs\/(\d+)\/cancel$/.exec(rest))) {
      const run = r.runs.find((x) => x.id === Number(m[1]));
      if (!run) return notFound();
      if (run.status === 'completed') return { status: 409, body: { message: 'Cannot cancel a workflow run that is completed.' } };
      if (this.hooks.onCancel) this.hooks.onCancel(r.fullName, run);
      else this.finishRun(run, 'cancelled');
      return { status: 202, body: {} };
    }
    if (method === 'GET' && (m = /^\/actions\/runs\/(\d+)\/artifacts$/.exec(rest))) {
      const list = r.artifacts.filter((a) => a.workflow_run.id === Number(m[1]));
      const per = Number(query.get('per_page') ?? 30);
      const page = Number(query.get('page') ?? 1);
      return { body: { total_count: list.length, artifacts: list.slice((page - 1) * per, page * per).map((a) => ({ ...a })) } };
    }
    if (method === 'GET' && (m = /^\/actions\/artifacts\/(\d+)\/zip$/.exec(rest))) {
      const a = r.artifacts.find((x) => x.id === Number(m[1]));
      if (!a || a.expired) return a ? { status: 410, body: { message: 'Artifact has expired' } } : notFound();
      return { status: 302, headers: { location: `${OBJECTS}/artifact/${a.id}` } };
    }
    if (method === 'GET' && rest === '/actions/artifacts') {
      const list = [...r.extraArtifacts(this.now()), ...r.artifacts].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const per = Number(query.get('per_page') ?? 30);
      const page = Number(query.get('page') ?? 1);
      return { body: { total_count: list.length, artifacts: list.slice((page - 1) * per, page * per) } };
    }
    // variables
    if (method === 'GET' && (m = /^\/environments\/([^/]+)\/variables\/([A-Z0-9_]+)$/.exec(rest))) {
      const v = r.envVariables[decodeURIComponent(m[1])]?.[m[2]];
      return v === undefined ? notFound() : { body: { name: m[2], value: v } };
    }
    if (method === 'GET' && (m = /^\/actions\/variables\/([A-Z0-9_]+)$/.exec(rest))) {
      const v = r.variables[m[1]];
      return v === undefined ? notFound() : { body: { name: m[1], value: v } };
    }
    if (method === 'GET' && rest === '/actions/organization-variables') return { body: { total_count: 0, variables: [] } };
    // issues
    if (method === 'GET' && rest === '/issues') {
      const label = query.get('labels');
      const want = query.get('state') ?? 'open';
      const list = r.issues.filter((i) => (want === 'all' || i.state === want) && (!label || i.labels.some((l) => l.name === label)));
      return { body: list.map((i) => ({ ...i })) };
    }
    if (method === 'POST' && rest === '/issues') {
      const n = r.issues.length + 1;
      const issue = { number: n, node_id: `I_${n}`, title: req.json.title, body: req.json.body, state: 'open', labels: (req.json.labels ?? []).map((name) => ({ name })) };
      r.issues.push(issue);
      return { status: 201, body: { ...issue } };
    }
    if (method === 'PATCH' && (m = /^\/issues\/(\d+)$/.exec(rest))) {
      const issue = r.issues.find((i) => i.number === Number(m[1]));
      if (!issue) return notFound();
      if (req.json?.body !== undefined) issue.body = req.json.body;
      if (req.json?.state === 'open' || req.json?.state === 'closed') issue.state = req.json.state;
      return { body: { ...issue } };
    }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      r.comments.push({ issue: Number(m[1]), body: req.json?.body, at: iso(this.now()) });
      return { status: 201, body: { id: this.id() } };
    }
    return notFound();
  }
}
