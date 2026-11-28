// Synthetic repros for lead issues (DESIGN-v3 section 7): a small server
// written from our own templates, in the lead's SDK idiom (language) and
// layout (server.json count, several servers in one repository), shaped by its
// class. No third-party code is copied: every file here is a fixed template of
// ours with a placeholder tool, `echo`.
//
// A template is only a claim until it has been run. reproSpec() says which of
// our tools runs it (the lane's own code at its pinned version, in
// scripts/lead-repro.mjs and .github/workflows/lead-repro.yml), and the issue
// shows the fixture only when that run reproduced the lead's class and
// signature (R-LEAD-54). Classes a template cannot trigger are said to be so.

import { createHash } from 'node:crypto';

/** Bumped whenever a template or what a runner does with it changes: every repro key changes with it. */
export const TEMPLATE_VERSION = 2;
/** What a lead-repro run can say of a repro. `error`: the run itself failed (our harness), which says nothing either way. */
export const REPRO_VERDICTS = Object.freeze(['reproduced', 'not_reproduced', 'not_reproducible_synthetically', 'error']);

/** The start-window templates do their start-up work for this long before they answer: longer than the 30 s window writecheck init gives. */
export const START_UP_SECONDS = 60;
/** The size the over-the-cap entry of the release template declares: more than release-diff's 4 GiB source and 512 MiB artifact caps. */
export const DECLARED_BYTES = 5 * 1024 ** 3;

/**
 * A read and an update tool on one noun (get_note, update_note): what writecheck init needs to draft a manifest.
 * The start-window templates and the start runners' control register these, so the only thing that can stop init on
 * the start-window template is its start-up time.
 */
const PY_PAIR = (noqa) => `from mcp.server.fastmcp import FastMCP${noqa}

mcp = FastMCP("lead-fixture")
NOTES: dict[str, str] = {}


@mcp.tool()
def get_note(id: str) -> str:
    """Read a note."""
    return NOTES.get(id, "")


@mcp.tool()
def update_note(id: str, text: str) -> str:
    """Update a note."""
    NOTES[id] = text
    return text


if __name__ == "__main__":
    mcp.run()
`;
const TS_PAIR = (load) => `${load}
const server = new McpServer({ name: "lead-fixture", version: "0.0.1" });
const notes = new Map<string, string>();
server.registerTool("get_note", {
  description: "Read a note.",
  inputSchema: { id: z.string() },
}, async ({ id }) => ({ content: [{ type: "text", text: notes.get(id) ?? "" }] }));
server.registerTool("update_note", {
  description: "Update a note.",
  inputSchema: { id: z.string(), text: z.string() },
}, async ({ id, text }) => { notes.set(id, text); return { content: [{ type: "text", text }] }; });
await server.connect(new StdioServerTransport());
`;

const PY = {
  base: (o) => `from mcp.server.fastmcp import FastMCP

mcp = FastMCP("lead-fixture")
${o.nameConst ? '\nTOOL_NAME = "echo"\n' : ''}${o.descConst ? 'ECHO_DESCRIPTION = "Echo the text back."\n' : ''}${o.annConst ? 'READ_ONLY = {"readOnlyHint": True}\n' : ''}
@mcp.tool(${[o.nameConst ? 'name=TOOL_NAME' : '', o.descConst ? 'description=ECHO_DESCRIPTION' : '', o.annConst ? 'annotations=READ_ONLY' : ''].filter(Boolean).join(', ')})
def echo(text: ${o.schemaModel ? 'EchoInput' : 'str'}) -> str:
${o.descConst ? '' : '    """Echo the text back."""\n'}    return ${o.schemaModel ? 'text.text' : 'text'}
${o.helper ? '\n\ndef register_more(server):\n    for name in ("upper", "lower"):\n        server.add_tool(lambda text: text, name=name)\n\n\nregister_more(mcp)\n' : ''}

if __name__ == "__main__":
    mcp.run()
`,
  // The start-up work runs before the SDK is even imported, so the fixture needs nothing installed to show it.
  slow: () => `import time

# Start-up work that runs before the server answers, longer than a start window allows.
START_UP_SECONDS = ${START_UP_SECONDS}
time.sleep(START_UP_SECONDS)

${PY_PAIR('  # noqa: E402')}`,
  control: () => PY_PAIR(''),
  file: 'server.py',
  extra: (o) => (o.schemaModel ? { 'models.py': 'from pydantic import BaseModel\n\n\nclass EchoInput(BaseModel):\n    text: str\n' } : {}),
  pkg: { 'pyproject.toml': '[project]\nname = "lead-fixture"\nversion = "0.0.1"\ndependencies = ["mcp"]\n\n[project.scripts]\nlead-fixture = "server:mcp.run"\n' },
  start: 'python3 server.py',
  ecosystem: 'pypi',
};
const TS = {
  base: (o) => `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "lead-fixture", version: "0.0.1" });
${o.nameConst ? 'const TOOL_NAME = "echo";\n' : ''}${o.descConst ? 'const ECHO_DESCRIPTION = "Echo the text back.";\n' : ''}${o.schemaModel ? 'const echoInput = { text: z.string() };\n' : ''}${o.annConst ? 'const readOnly = { readOnlyHint: true };\n' : ''}
server.registerTool(${o.nameConst ? 'TOOL_NAME' : '"echo"'}, {
  description: ${o.descConst ? 'ECHO_DESCRIPTION' : '"Echo the text back."'},
  inputSchema: ${o.schemaModel ? 'echoInput' : '{ text: z.string() }'},${o.annConst ? '\n  annotations: readOnly,' : ''}
}, async ({ text }) => ({ content: [{ type: "text", text }] }));
${o.helper ? '\nfor (const name of ["upper", "lower"]) {\n  server.registerTool(name, { description: name, inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));\n}\n' : ''}
await server.connect(new StdioServerTransport());
`,
  slow: () => `import { setTimeout as sleep } from "node:timers/promises";

// Start-up work that runs before the server answers, longer than a start window allows.
const START_UP_MS = ${START_UP_SECONDS}_000;
await sleep(START_UP_MS);

${TS_PAIR(`const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = await import("zod");`)}`,
  control: () => TS_PAIR(`import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";`),
  file: 'src/index.ts',
  extra: () => ({}),
  pkg: { 'package.json': '{\n  "name": "lead-fixture",\n  "version": "0.0.1",\n  "type": "module",\n  "bin": { "lead-fixture": "dist/index.js" },\n  "dependencies": { "@modelcontextprotocol/sdk": "^1", "zod": "^3" }\n}\n' },
  // Node 22.6 and later run the TypeScript file as it is (types stripped): no build step stands between the fixture and the run.
  start: 'node --experimental-strip-types src/index.ts',
  ecosystem: 'npm',
};
const GO = {
  base: (o) => `package main

import (
\t"context"

\t"github.com/modelcontextprotocol/go-sdk/mcp"
)

type EchoInput struct {
\tText string \`json:"text"\`
}
${o.nameConst ? '\nconst toolName = "echo"\n' : ''}${o.descConst ? '\nconst echoDescription = "Echo the text back."\n' : ''}
func echo(ctx context.Context, req *mcp.CallToolRequest, in EchoInput) (*mcp.CallToolResult, any, error) {
\treturn &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: in.Text}}}, nil, nil
}

func main() {
\tserver := mcp.NewServer(&mcp.Implementation{Name: "lead-fixture", Version: "0.0.1"}, nil)
\tmcp.AddTool(server, &mcp.Tool{Name: ${o.nameConst ? 'toolName' : '"echo"'}, Description: ${o.descConst ? 'echoDescription' : '"Echo the text back."'}}, echo)
\t_ = server.Run(context.Background(), &mcp.StdioTransport{})
}
`,
  slow: null,
  file: 'main.go',
  extra: () => ({}),
  pkg: { 'go.mod': 'module example.test/lead-fixture\n\ngo 1.23\n\nrequire github.com/modelcontextprotocol/go-sdk v1\n' },
  start: 'go run .',
  ecosystem: null,
};
const RS = {
  base: (o) => `use rmcp::{handler::server::wrapper::Parameters, schemars, tool, tool_router, ServiceExt, transport::stdio};

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct EchoInput {
    text: String,
}
${o.descConst ? '\nconst ECHO_DESCRIPTION: &str = "Echo the text back.";\n' : ''}
#[derive(Clone)]
struct Fixture;

#[tool_router]
impl Fixture {
    #[tool(${o.nameConst ? 'name = TOOL_NAME, ' : ''}description = ${o.descConst ? 'ECHO_DESCRIPTION' : '"Echo the text back."'})]
    async fn echo(&self, Parameters(input): Parameters<EchoInput>) -> String {
        input.text
    }
}
${o.nameConst ? '\nconst TOOL_NAME: &str = "echo";\n' : ''}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    Fixture.serve(stdio()).await?.waiting().await?;
    Ok(())
}
`,
  slow: null,
  file: 'src/main.rs',
  extra: () => ({}),
  pkg: { 'Cargo.toml': '[package]\nname = "lead-fixture"\nversion = "0.0.1"\nedition = "2021"\n\n[dependencies]\nrmcp = { version = "0", features = ["server", "transport-io"] }\ntokio = { version = "1", features = ["full"] }\nserde = { version = "1", features = ["derive"] }\nschemars = "0"\nanyhow = "1"\n' },
  start: 'cargo run',
  ecosystem: null,
};
export const TEMPLATES = Object.freeze({ python: PY, ts: TS, go: GO, rust: RS });
const LANG_NAME = { ts: 'TypeScript', python: 'Python', go: 'Go', rust: 'Rust' };

/**
 * The language part of an idiom (state/fingerprint.mjs idiomOf): `none/<lang>` when the reader listed nothing,
 * else `<from>/<fidelity>/<lang>`; a language may hold a slash itself (ts/js, java/kotlin). `repo:` is taken off.
 */
export const langPart = (idiom) => { const p = String(idiom ?? '').split('/'); return p.slice(p[0] === 'none' ? 1 : 2).join('/').replace(/^repo:/, ''); };

/** The idiom's language as a template key, or null (no template for it yet). */
export function languageOf(idiom) {
  const lang = langPart(idiom);
  if (lang === 'python') return 'python';
  if (['ts/js', 'typescript', 'javascript'].includes(lang)) return 'ts';
  if (lang === 'go') return 'go';
  if (lang === 'rust') return 'rust';
  return null;
}

/** What the fixture varies, from the lead's class and partial kind. */
function variantOf(lead) {
  const partial = /;partial=([a-z_]+)/.exec(lead.signature ?? '')?.[1] ?? null;
  const o = { nameConst: false, descConst: false, schemaModel: false, annConst: false, helper: false, slow: false };
  if (partial === 'unresolved_names') o.nameConst = true;
  else if (partial === 'unreadable_descriptions') o.descConst = true;
  else if (partial === 'unreadable_input_schemas') o.schemaModel = true;
  else if (partial === 'unreadable_annotations') o.annConst = true;
  else if (partial === 'tools_left_out' || partial === 'registration_not_seen') o.helper = true;
  else if (lead.class === 'no_tools_found') o.helper = true;
  return { o, partial };
}

const EXPECT = {
  no_tools_found: 'the reader finds the tool registrations (echo, upper, lower) and grades them',
  reader_limit: 'the reader resolves every tool with its name, description, input schema and annotations, with no partial-read counts',
  unsupported_layout: 'each server in the repository is read on its own',
  unsupported_language: 'the reader reads the language or says so as a stated limit',
  timeout_start: 'the server starts inside the start window and lists echo, or the probe says the start window was too short as a stated limit',
  no_runnable_artifact: 'the probe finds how to run the fixture (its package metadata) and starts it',
  install_failed_registry: 'the probe installs the fixture\'s declared package and starts it',
  unsupported_transport: 'the probe connects over the transport the fixture declares',
  tool_error: 'the tool finishes without an error of its own',
  too_large: 'the input is read, or the size cap is reported as a stated limit',
};

/** release-diff stages whose too_large a template can trigger: the source archive, and the npm or PyPI artifact. */
const RELEASE_STAGES = Object.freeze({ source: 'source', npm: 'artifact', pypi: 'artifact' });

/**
 * What a lead's repro is, and which of our tools runs it. Only lead shape columns are read.
 * @returns {{
 *   key: string|null, runner: 'scan-static'|'writecheck-init'|'release-diff'|null, synthesizable: boolean, why: string|null,
 *   files: Array<[string, string]>, dir: string, start: string|null, release: object|null, partial: string|null, o: object,
 * }}
 *   runner null with synthesizable false: no template of ours can trigger this class (why says so).
 */
export function reproSpec(lead) {
  const key = languageOf(lead.idiom);
  const { o, partial } = variantOf(lead);
  const lane = lead.lane;
  const none = (why) => ({ key, runner: null, synthesizable: false, why, files: [], dir: '.', start: null, release: null, partial, o });
  if (!key) return none(`no fixture template for the idiom \`${lead.idiom}\` yet`);
  const t = TEMPLATES[key];
  let runner = null;
  let release = null;
  if (lane === 'scan-static') runner = 'scan-static';
  else if (lane === 'writecheck') {
    if (lead.component !== 'init' || lead.class !== 'timeout_start') return none(`the writecheck lane's \`${lead.component}\` stage runs a registry package in the sandbox; no template of ours stands in for \`${lead.class}\` there`);
    if (!t.slow) return none(`no start-window template for ${LANG_NAME[key]} yet (it would need a build before it starts)`);
    runner = 'writecheck-init';
    o.slow = true;
  } else if (lane === 'release-diff') {
    const where = RELEASE_STAGES[lead.component];
    if (lead.class !== 'too_large' || !where) return none(`release-diff's \`${lead.component}\` stage reads published registries; no template of ours triggers \`${lead.class}\` there`);
    if (!t.ecosystem) return none(`no release template for ${LANG_NAME[key]} (it publishes to no registry release-diff reads)`);
    if (where === 'artifact' && lead.component !== t.ecosystem) return none(`the template for ${LANG_NAME[key]} publishes to ${t.ecosystem}, not ${lead.component}`);
    runner = 'release-diff';
    release = { ecosystem: t.ecosystem, name: 'lead-fixture', version: '0.0.1', tag: 'v0.0.1', over_cap: { where, path: where === 'source' ? 'data/blob.bin' : 'blob.bin', declared_bytes: DECLARED_BYTES } };
  } else if (lane === 'live-probe') {
    return none('the live-probe lane installs the server from its registry package and starts it in the sandbox; a fixture of ours is not a registry package');
  } else {
    return none(`no runner for the ${lane} lane`);
  }
  const files = new Map();
  const multi = /multi_server/.test(lead.layout ?? '');
  const dirs = multi ? ['servers/a', 'servers/b'] : ['.'];
  for (const d of dirs) {
    const p = (f) => (d === '.' ? f : `${d}/${f}`);
    files.set(p(t.file), o.slow ? t.slow() : t.base(o));
    for (const [f, v] of Object.entries(t.extra(o))) files.set(p(f), v);
    if (lane === 'live-probe' || lane === 'writecheck' || lane === 'release-diff') for (const [f, v] of Object.entries(t.pkg)) files.set(p(f), v);
  }
  const sj = /server_json:(0|1|many)/.exec(lead.layout ?? '')?.[1] ?? null;
  const serverJson = (name) => `{\n  "name": "io.github.example/${name}",\n  "description": "Synthetic fixture for a tool-qa lead.",\n  "version": "0.0.1"\n}\n`;
  if (sj === '1') files.set('server.json', serverJson('lead-fixture'));
  if (sj === 'many') { files.set('servers/a/server.json', serverJson('lead-fixture-a')); files.set('servers/b/server.json', serverJson('lead-fixture-b')); }
  return { key, runner, synthesizable: true, why: null, files: [...files], dir: multi ? 'servers/a' : '.', start: runner === 'writecheck-init' ? t.start : null, release, partial, o };
}

/**
 * The control of a start runner: the start-window template without its start-up delay (a read and an update tool),
 * with its package metadata. It must pass writecheck init (exit 0) before any verdict of that runner counts: a
 * harness that cannot start a good server, or a fixture init cannot draft from, would make every start class look
 * reproduced (the first lead-repro run showed it: a plain echo server ends init with exit 4, "no pair of read and
 * update tools", which the lane counts as timeout_start).
 */
export function controlFiles(spec) {
  const t = TEMPLATES[spec.key];
  if (!t || !t.control) return [];
  return [[t.file, t.control()], ...Object.entries(t.pkg)];
}

/** The pinned versions a runner's verdict depends on, from pump/workflows.json (the lane's versions.tool). */
export function pinsFor(lane, workflows) {
  const tool = workflows?.[lane]?.versions?.tool;
  return tool && typeof tool === 'object' ? Object.fromEntries(Object.entries(tool).sort(([a], [b]) => a.localeCompare(b))) : {};
}

/**
 * The repro key: what a verdict is about. The same template, run the same way, at the same pins, against the same
 * class and signature gives the same key, so one lead-repro run serves every lead that shares it.
 */
export function reproKey(lead, spec, pins) {
  const doc = {
    v: TEMPLATE_VERSION, runner: spec.runner, files: spec.files, dir: spec.dir, start: spec.start, release: spec.release, pins,
    expect: { lane: lead.lane, component: lead.component, class: lead.class, signature: lead.signature },
  };
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 16);
}

const fenceLang = (f) => (f.endsWith('.py') ? 'python' : f.endsWith('.ts') ? 'ts' : f.endsWith('.go') ? 'go' : f.endsWith('.rs') ? 'rust' : f.endsWith('.json') ? 'json' : f.endsWith('.toml') ? 'toml' : '');
const gib = (n) => `${Math.round(n / 1024 ** 3)} GiB`;

/** The run line of a spec, as the issue shows it. */
export function runLine(spec) {
  if (spec.runner === 'scan-static') return `npx @isokron/mcp-check --repo-dir ${spec.dir} --format json`;
  if (spec.runner === 'writecheck-init') return `cd ${spec.dir} && mcp-writecheck init --out init-draft.yaml -- ${spec.start}`;
  if (spec.runner === 'release-diff') return 'release-diff over local stand-ins for the registry, git refs and codeload (tool-qa scripts/lead-repro.mjs)';
  return null;
}

/** The lines that say why an issue shows no fixture. */
export const NOT_CONFIRMED = 'Synthetic repro: not confirmed (our template did not trigger it); evidence is the real-server re-check below.';
export const NOT_SYNTHESIZABLE = (why) => `Synthetic repro: not confirmed (no template of ours can trigger this class: ${why}); evidence is the real-server re-check below.`;
export const NOT_CHECKED = 'Synthetic repro: not confirmed (the check of our template did not finish); evidence is the real-server re-check below.';

/**
 * The synthetic repro section of a lead's issue, as Markdown. The fixture and its run line are shown only when
 * lead-repro reproduced the lead with it (`verdict.verdict === 'reproduced'` for this lead's repro key): any other
 * verdict, or none, says so in one plain line and shows no fixture (R-LEAD-54).
 * @param {object} lead  shape columns
 * @param {{verdict?: {verdict: string, run_id?: number, key?: string, tool?: string}|null}} [o]
 */
export function syntheticRepro(lead, { verdict = null } = {}) {
  const spec = reproSpec(lead);
  if (!spec.synthesizable) return NOT_SYNTHESIZABLE(spec.why);
  if (!verdict || verdict.verdict !== 'reproduced') {
    if (verdict?.verdict === 'not_reproducible_synthetically') return NOT_SYNTHESIZABLE(verdict.why ?? 'the runner says so');
    if (verdict?.verdict === 'not_reproduced') return NOT_CONFIRMED;
    return NOT_CHECKED;
  }
  const { partial, o } = spec;
  const L = [];
  const saw = `\`${lead.class}${partial ? `:${partial}` : ''}\` at component \`${lead.component}\` (signature \`${lead.signature}\`)`;
  const runRef = Number.isSafeInteger(verdict.run_id) ? `tool-qa lead-repro run ${verdict.run_id}` : 'tool-qa lead-repro';
  L.push(`Confirmed: ${runRef} ran this fixture with ${verdict.tool ? `\`${verdict.tool}\`` : 'the lane\'s pinned tool'} and saw the same class and signature (repro key \`${verdict.key ?? '-'}\`).`, '');
  L.push(`Written from our own ${LANG_NAME[spec.key]} template for the idiom \`${lead.idiom}\` and layout \`${lead.layout}\`; no third-party code.${o.nameConst || o.descConst || o.schemaModel || o.annConst || o.helper ? ' The part that varies for this class is marked by the constant or helper the reader has to follow.' : ''}${o.slow ? ` It does ${START_UP_SECONDS} s of start-up work before it answers, and registers a read and an update tool so that writecheck init has something to draft from once it does.` : ''}`, '');
  for (const [f, v] of spec.files) L.push(`\`${f}\``, '', `\`\`\`${fenceLang(f)}`, v.trimEnd(), '```', '');
  if (spec.release) {
    const r = spec.release;
    const where = r.over_cap.where === 'source' ? `the source archive at its tag \`${r.tag}\` holds the same files` : 'the artifact holds the same files';
    L.push(`Published as the ${r.ecosystem === 'pypi' ? 'PyPI sdist' : 'npm tarball'} \`${r.name} ${r.version}\`; ${where} and \`${r.over_cap.path}\`, an entry whose header declares ${gib(r.over_cap.declared_bytes)} (over the reader's cap; our generator writes the header only).`, '');
  }
  const run = runLine(spec);
  if (run) L.push(`Run: \`${run}\``, '');
  L.push(`Expected: ${EXPECT[lead.class] ?? 'the stage finishes'}. The loop saw ${saw}.`);
  return L.join('\n');
}

/**
 * The fixture files an issue body shows under "### Synthetic repro" (`path`, then a fenced block), as
 * [path, text] pairs. An issue filed before the fixture was confirmed shows none.
 */
export function filesFromBody(body) {
  const text = String(body ?? '');
  const start = text.indexOf('### Synthetic repro');
  if (start < 0) return [];
  const rest = text.slice(start + '### Synthetic repro'.length);
  const end = rest.search(/\n### /);
  const section = end < 0 ? rest : rest.slice(0, end);
  const out = [];
  for (const m of section.matchAll(/^`([^`\n]+)`\n\n```[a-z]*\n([\s\S]*?)\n```$/gm)) {
    const path = m[1];
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(path) || path.split('/').some((s) => s === '..' || s === '' || s === '.')) continue;
    out.push([path, `${m[2]}\n`]);
  }
  return out;
}

/** A lead's shape from its issue body's field table (leads/plan.mjs issueFor), or null when it is not a lead issue. */
export function shapeFromBody(body) {
  const text = String(body ?? '');
  const marker = /<!-- tool-qa lead ([0-9a-f]{12}) -->/.exec(text);
  if (!marker) return null;
  const row = (name) => new RegExp(`^\\| ${name} \\| (.*) \\|$`, 'm').exec(text)?.[1] ?? null;
  const code = (v) => /^`([^`]*)`/.exec(v ?? '')?.[1] ?? null;
  const tool = row('Tool');
  const lco = (row('Lane / component / oracle') ?? '').split(' / ').map((s) => s.trim());
  const signature = code(row('Signature'));
  const cls = /(?:^|;)class=([a-z_]+)/.exec(signature ?? '')?.[1] ?? null;
  const versions = /seen on: ([^)]*)\)/.exec(tool ?? '')?.[1]?.split(', ').filter((v) => v && v !== 'none recorded') ?? [];
  const shape = {
    fingerprint: marker[1], tool: (tool ?? '').split(' ')[0] || null, lane: lco[0] || null, component: lco[1] || null, oracle: lco[2] || null,
    class: cls, idiom: code(row('SDK idiom')), layout: code(row('Layout')), signature, fault: (row('Fault side') ?? '').split(' ')[0] || null, versions,
  };
  return Object.values(shape).some((v) => v === null) ? null : shape;
}
