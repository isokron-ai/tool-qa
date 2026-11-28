// Synthetic repros for lead issues (DESIGN-v3 section 7): a small server
// written from our own templates, in the lead's SDK idiom (language) and
// layout (server.json count, several servers in one repository), shaped by its
// class. No third-party code is copied: every file here is a fixed template of
// ours with a placeholder tool, `echo`. It is a starting fixture: the lead's
// tags are coarse, so the issue says what the loop saw and what the fixture
// should show, and the fix starts by making the fixture fail the same way.

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
  file: 'server.py',
  extra: (o) => (o.schemaModel ? { 'models.py': 'from pydantic import BaseModel\n\n\nclass EchoInput(BaseModel):\n    text: str\n' } : {}),
  pkg: { 'pyproject.toml': '[project]\nname = "lead-fixture"\nversion = "0.0.1"\ndependencies = ["mcp"]\n\n[project.scripts]\nlead-fixture = "server:mcp.run"\n' },
  start: 'python server.py',
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
  file: 'src/index.ts',
  extra: () => ({}),
  pkg: { 'package.json': '{\n  "name": "lead-fixture",\n  "version": "0.0.1",\n  "type": "module",\n  "bin": { "lead-fixture": "dist/index.js" },\n  "dependencies": { "@modelcontextprotocol/sdk": "^1", "zod": "^3" }\n}\n' },
  start: 'node dist/index.js',
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
  file: 'main.go',
  extra: () => ({}),
  pkg: { 'go.mod': 'module example.test/lead-fixture\n\ngo 1.23\n\nrequire github.com/modelcontextprotocol/go-sdk v1\n' },
  start: 'go run .',
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
  file: 'src/main.rs',
  extra: () => ({}),
  pkg: { 'Cargo.toml': '[package]\nname = "lead-fixture"\nversion = "0.0.1"\nedition = "2021"\n\n[dependencies]\nrmcp = { version = "0", features = ["server", "transport-io"] }\ntokio = { version = "1", features = ["full"] }\nserde = { version = "1", features = ["derive"] }\nschemars = "0"\nanyhow = "1"\n' },
  start: 'cargo run',
};
const TEMPLATES = { python: PY, ts: TS, go: GO, rust: RS };

/**
 * The language part of an idiom (state/fingerprint.mjs idiomOf): `none/<lang>` when the reader listed nothing,
 * else `<from>/<fidelity>/<lang>`; a language may hold a slash itself (ts/js, java/kotlin). `repo:` is taken off.
 */
const langPart = (idiom) => { const p = String(idiom ?? '').split('/'); return p.slice(p[0] === 'none' ? 1 : 2).join('/').replace(/^repo:/, ''); };

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
  const o = { nameConst: false, descConst: false, schemaModel: false, annConst: false, helper: false };
  if (partial === 'unresolved_names') o.nameConst = true;
  else if (partial === 'unreadable_descriptions') o.descConst = true;
  else if (partial === 'unreadable_input_schemas') o.schemaModel = true;
  else if (partial === 'unreadable_annotations') o.annConst = true;
  else if (partial === 'tools_left_out' || partial === 'registration_not_seen') o.helper = true;
  else if (lead.class === 'no_tools_found') o.helper = true;
  return { o, partial };
}

const COMMAND = {
  'scan-static': (dir) => `npx @isokron/mcp-check --repo-dir ${dir} --format json`,
  'live-probe': (dir, t) => `npx @isokron/mcp-check -- sh -c 'cd ${dir} && ${t.start}'`,
};

const EXPECT = {
  no_tools_found: 'the reader finds the tool registrations (echo, upper, lower) and grades them',
  reader_limit: 'the reader resolves every tool with its name, description, input schema and annotations, with no partial-read counts',
  unsupported_layout: 'each server in the repository is read on its own',
  unsupported_language: 'the reader reads the language or says so as a stated limit',
  timeout_start: 'the server starts inside the probe\'s start window and lists echo',
  no_runnable_artifact: 'the probe finds how to run the fixture (its package metadata) and starts it',
  install_failed_registry: 'the probe installs the fixture\'s declared package and starts it',
  unsupported_transport: 'the probe connects over the transport the fixture declares',
  tool_error: 'the tool finishes without an error of its own',
  too_large: 'the input is read, or the size cap is reported as a stated limit',
};

/**
 * The synthetic repro of a lead, as Markdown: a file tree from our templates,
 * the command to run on it, what the run should show, and what the loop saw.
 * Only lead shape columns are read.
 */
export function syntheticRepro(lead) {
  const key = languageOf(lead.idiom);
  const { o, partial } = variantOf(lead);
  const L = [];
  const saw = `\`${lead.class}${partial ? `:${partial}` : ''}\` at component \`${lead.component}\` (signature \`${lead.signature}\`)`;
  if (!key) {
    L.push(`No fixture template for the idiom \`${lead.idiom}\` yet. The shape above is the repro: a ${langPart(lead.idiom)} server${/multi_server/.test(lead.layout) ? ' with several servers in one repository' : ''} gives ${saw}.`);
    return L.join('\n');
  }
  const t = TEMPLATES[key];
  const files = new Map();
  const multi = /multi_server/.test(lead.layout ?? '');
  const dirs = multi ? ['servers/a', 'servers/b'] : ['.'];
  for (const d of dirs) {
    const p = (f) => (d === '.' ? f : `${d}/${f}`);
    files.set(p(t.file), t.base(o));
    for (const [f, v] of Object.entries(t.extra(o))) files.set(p(f), v);
    if (lead.lane === 'live-probe' || lead.lane === 'writecheck') for (const [f, v] of Object.entries(t.pkg)) files.set(p(f), v);
  }
  const sj = /server_json:(0|1|many)/.exec(lead.layout ?? '')?.[1] ?? null;
  const serverJson = (name) => `{\n  "name": "io.github.example/${name}",\n  "description": "Synthetic fixture for a tool-qa lead.",\n  "version": "0.0.1"\n}\n`;
  if (sj === '1') files.set('server.json', serverJson('lead-fixture'));
  if (sj === 'many') { files.set('servers/a/server.json', serverJson('lead-fixture-a')); files.set('servers/b/server.json', serverJson('lead-fixture-b')); }
  L.push(`Written from our own ${key === 'ts' ? 'TypeScript' : key === 'python' ? 'Python' : key === 'go' ? 'Go' : 'Rust'} template for the idiom \`${lead.idiom}\` and layout \`${lead.layout}\`; no third-party code.${o.nameConst || o.descConst || o.schemaModel || o.annConst || o.helper ? ' The part that varies for this class is marked by the constant or helper the reader has to follow.' : ''}`, '');
  for (const [f, v] of files) {
    const lang = f.endsWith('.py') ? 'python' : f.endsWith('.ts') ? 'ts' : f.endsWith('.go') ? 'go' : f.endsWith('.rs') ? 'rust' : f.endsWith('.json') ? 'json' : f.endsWith('.toml') ? 'toml' : '';
    L.push(`\`${f}\``, '', `\`\`\`${lang}`, v.trimEnd(), '```', '');
  }
  const cmd = COMMAND[lead.lane];
  if (cmd) L.push(`Run: \`${cmd(multi ? 'servers/a' : '.', t)}\``, '');
  L.push(`Expected: ${EXPECT[lead.class] ?? 'the stage finishes'}. The loop saw ${saw}.`);
  return L.join('\n');
}
