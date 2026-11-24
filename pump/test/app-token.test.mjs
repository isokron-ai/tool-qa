import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';

import { createAppJwt, mintInstallationToken } from '../app-token.mjs';
import { API, fakeApi } from '../../test/lib/fake-api.mjs';

// A throwaway key made for this test run only.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const NOW = Date.parse('2026-03-02T10:00:00Z');

function decode(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

test('the app JWT is RS256, short-lived, back-dated a minute, and verifies', () => {
  const jwt = createAppJwt({ appId: '12345', privateKey, now: NOW });
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' });
  const payload = decode(p);
  assert.equal(payload.iss, 12345);
  assert.equal(payload.iat, NOW / 1000 - 60);
  assert.equal(payload.exp, NOW / 1000 + 540);
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
});

test('a key pasted with literal \\n sequences still works', () => {
  const flat = privateKey.replace(/\n/g, '\\n');
  const jwt = createAppJwt({ appId: 'Iv1.abc', privateKey: flat, now: NOW });
  const [h, p, s] = jwt.split('.');
  assert.equal(decode(p).iss, 'Iv1.abc');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
});

test('createAppJwt refuses missing inputs', () => {
  assert.throws(() => createAppJwt({ appId: '', privateKey, now: NOW }), /app id/i);
  assert.throws(() => createAppJwt({ appId: '1', privateKey: '', now: NOW }), /private key/i);
});

function tokenRoute(response, seen) {
  return ['POST', '/app/installations/99/access_tokens', (req) => {
    seen.push(req);
    return { status: 201, body: response(req) };
  }];
}

test('mintInstallationToken narrows to the named repositories and permissions', async () => {
  const seen = [];
  const api = fakeApi([tokenRoute((req) => ({
    token: 'ghs_synthetic_minted',
    expires_at: '2026-03-02T11:00:00Z',
    permissions: { ...req.json.permissions, metadata: 'read' },
    repository_selection: 'selected',
  }), seen)]);
  const out = await mintInstallationToken({
    appId: '12345', privateKey, installationId: '99', repositories: ['scan-static'], permissions: { actions: 'write' },
    fetch: api.fetch, apiUrl: API, now: () => NOW,
  });
  assert.equal(out.token, 'ghs_synthetic_minted');
  assert.equal(out.expiresAt, Date.parse('2026-03-02T11:00:00Z'));
  assert.deepEqual(seen[0].json, { repositories: ['scan-static'], permissions: { actions: 'write' } });
  assert.match(seen[0].headers.get('authorization'), /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});

test('a token with more permissions than asked for is refused', async () => {
  const api = fakeApi([tokenRoute(() => ({
    token: 'ghs_synthetic_minted',
    expires_at: '2026-03-02T11:00:00Z',
    permissions: { actions: 'write', contents: 'write', metadata: 'read' },
  }), [])]);
  await assert.rejects(
    mintInstallationToken({
      appId: '1', privateKey, installationId: '99', repositories: ['tool-qa'], permissions: { actions: 'write' },
      fetch: api.fetch, apiUrl: API, now: () => NOW,
    }),
    /contents/,
  );
});

test('a token with a higher level than asked for is refused', async () => {
  const api = fakeApi([tokenRoute(() => ({
    token: 'ghs_synthetic_minted',
    expires_at: '2026-03-02T11:00:00Z',
    permissions: { issues: 'write' },
  }), [])]);
  await assert.rejects(
    mintInstallationToken({
      appId: '1', privateKey, installationId: '99', repositories: ['tool-qa'], permissions: { issues: 'read' },
      fetch: api.fetch, apiUrl: API, now: () => NOW,
    }),
    /issues/,
  );
});

test('an unscoped token is never requested', async () => {
  const api = fakeApi([]);
  const base = { appId: '1', privateKey, installationId: '99', fetch: api.fetch, apiUrl: API, now: () => NOW };
  await assert.rejects(mintInstallationToken({ ...base, repositories: [], permissions: { actions: 'write' } }), /repositor/);
  await assert.rejects(mintInstallationToken({ ...base, repositories: ['tool-qa'], permissions: {} }), /permission/);
  await assert.rejects(mintInstallationToken({ ...base, repositories: ['other-org/tool-qa'], permissions: { actions: 'write' } }), /name/);
  assert.equal(api.calls.length, 0);
});

test('errors from the token endpoint carry no key material or JWT', async () => {
  const api = fakeApi([['POST', '/app/installations/99/access_tokens', (req) => ({
    status: 401,
    body: { message: `bad credentials ${req.headers.get('authorization')}` },
  })]]);
  await assert.rejects(
    mintInstallationToken({
      appId: '1', privateKey, installationId: '99', repositories: ['tool-qa'], permissions: { actions: 'write' },
      fetch: api.fetch, apiUrl: API, now: () => NOW,
    }),
    (err) => {
      assert.equal(err.status, 401);
      assert.ok(!/eyJ/.test(err.message), err.message);
      assert.ok(!err.message.includes('PRIVATE KEY'));
      return true;
    },
  );
});
