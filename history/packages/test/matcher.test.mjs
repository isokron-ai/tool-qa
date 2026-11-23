import test from 'node:test';
import assert from 'node:assert/strict';
import { nameMatches, keywordsMatch, matchesMcp, matchReasons, tokens } from '../lib/matcher.mjs';

test('name token match', () => {
  for (const n of ['mcp', 'mcp-server', '@acme/mcp', 'foo_mcp_bar', 'github.com/x/go-mcp', 'MCP-Thing', 'server.mcp.v2']) assert.ok(nameMatches(n), n);
});
test('name non-match: mcp only as substring', () => {
  for (const n of ['mcpx', 'xmcp', 'dumcpster', 'lodash', '', null, undefined, 'mc-p']) assert.ok(!nameMatches(n), String(n));
});
test('keywords', () => {
  assert.ok(keywordsMatch(['x', 'MCP']));
  assert.ok(keywordsMatch(['modelcontextprotocol']));
  assert.ok(keywordsMatch('foo, mcp'));
  assert.ok(!keywordsMatch(['model', 'context']));
  assert.ok(!keywordsMatch(undefined));
});
test('description and combined reasons', () => {
  assert.deepEqual(matchReasons({ name: 'x', description: 'A Model Context Protocol server' }), ['description']);
  assert.deepEqual(matchReasons({ name: 'a-mcp', keywords: ['mcp'] }), ['name', 'keyword']);
  assert.ok(!matchesMcp({ name: 'express', keywords: ['web'], description: 'web framework' }));
  assert.ok(!matchesMcp());
});
test('tokens', () => assert.deepEqual(tokens('@a/b-c_d.e'), ['a', 'b', 'c', 'd', 'e']));
