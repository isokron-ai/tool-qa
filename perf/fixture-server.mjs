#!/usr/bin/env node
// A control, not a product: a dependency-free MCP server over stdio with one
// read-only tool, `echo`, and a settable delay.
//
//   node perf/fixture-server.mjs [--delay-ms N | --delay-ms=N]
//
// The performance harness runs it twice, once fast and once with a delay, and
// must see the delay as a regression (test/perf-harness.test.mjs). It speaks
// just enough of the protocol for the Inspector: initialize, ping, tools/list
// and tools/call over newline-delimited JSON-RPC. No network, no files.

import { createInterface } from 'node:readline';

const eq = process.argv.find((a) => a.startsWith('--delay-ms='));
const arg = process.argv.indexOf('--delay-ms');
const delayMs = eq ? Number(eq.slice('--delay-ms='.length)) : arg > 0 ? Number(process.argv[arg + 1]) : 0;
if (!Number.isFinite(delayMs) || delayMs < 0) {
  process.stderr.write('fixture-server: --delay-ms must be a number of milliseconds, 0 or more\n');
  process.exit(2);
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOOLS = [{
  name: 'echo',
  description: 'Returns the text it was given. Read-only.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'perf-fixture', version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      if (params?.name !== 'echo') return fail(-32602, `unknown tool ${params?.name}`);
      if (delayMs > 0) await sleep(delayMs);
      return reply({ content: [{ type: 'text', text: String(params.arguments?.text ?? '') }], isError: false });
    }
    default:
      return method?.startsWith('notifications/') ? undefined : fail(-32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  handle(msg).catch((e) => process.stderr.write(`fixture-server: ${e.message}\n`));
});
rl.on('close', () => process.exit(0));
