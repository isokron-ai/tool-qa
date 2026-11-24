// GitHub App tokens for the loop, with node:crypto only.
//
// createAppJwt() signs the short-lived app JWT. mintInstallationToken() trades
// it for an installation token narrowed to the repositories and permissions a
// call needs (for example { actions: 'write' } on one worker repository), and
// refuses the token if GitHub hands back anything broader. Tokens last at most
// an hour and are never written to disk or logs.

import { createPrivateKey, sign } from 'node:crypto';

import { createClient } from './github.mjs';

const LEVELS = { read: 1, write: 2, admin: 3 };

function b64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

/** Accept a PEM key as stored in a secret, including one pasted with literal \n. */
export function normalizeKey(privateKey) {
  let pem = String(privateKey ?? '').trim();
  if (!pem.includes('\n') && pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n');
  return pem;
}

/**
 * The app JWT: RS256, issued a minute in the past (clock drift), valid 9 minutes.
 * @param {{ appId: string|number, privateKey: string, now?: number }} opts
 */
export function createAppJwt({ appId, privateKey, now = Date.now() }) {
  if (appId === undefined || appId === null || String(appId).trim() === '') throw new TypeError('createAppJwt: the app id is required');
  const pem = normalizeKey(privateKey);
  if (!pem) throw new TypeError('createAppJwt: the private key is required');
  const id = String(appId).trim();
  const iat = Math.floor(now / 1000) - 60;
  const payload = { iat, exp: iat + 600, iss: /^\d+$/.test(id) ? Number(id) : id };
  const data = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}`;
  const key = createPrivateKey({ key: pem, format: 'pem' });
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}

/** Throw unless `granted` is within `asked` (metadata: read is always included). */
export function checkPermissions(asked, granted) {
  for (const [name, level] of Object.entries(granted ?? {})) {
    if (name === 'metadata' && level === 'read') continue;
    const want = asked[name];
    if (!want) throw new Error(`installation token has permission ${name}: ${level}, which was not asked for`);
    if ((LEVELS[level] ?? 99) > (LEVELS[want] ?? 0)) throw new Error(`installation token has ${name}: ${level}, more than the ${want} asked for`);
  }
}

/**
 * Mint an installation token narrowed to `repositories` (names in the
 * installation's account) and `permissions`.
 * @returns {Promise<{ token: string, expiresAt: number, permissions: object }>}
 */
export async function mintInstallationToken({
  appId,
  privateKey,
  installationId,
  repositories,
  permissions,
  fetch = globalThis.fetch,
  apiUrl,
  now = Date.now,
  sleep,
  budget,
}) {
  if (!installationId || !/^\d+$/.test(String(installationId).trim())) throw new TypeError('mintInstallationToken: a numeric installation id is required');
  if (!Array.isArray(repositories) || repositories.length === 0) throw new TypeError('mintInstallationToken: name at least one repository');
  for (const r of repositories) {
    if (!/^[A-Za-z0-9_.-]+$/.test(String(r))) throw new TypeError(`mintInstallationToken: "${r}" is not a repository name (no owner prefix)`);
  }
  if (!permissions || Object.keys(permissions).length === 0) throw new TypeError('mintInstallationToken: name at least one permission');
  for (const [k, v] of Object.entries(permissions)) {
    if (!LEVELS[v] || v === 'admin') throw new TypeError(`mintInstallationToken: permission ${k} must be read or write`);
  }
  const jwt = createAppJwt({ appId, privateKey, now: now() });
  const client = createClient({ token: jwt, fetch, apiUrl, now, sleep, budget, maxAttempts: 3 });
  const res = await client.request('POST', `/app/installations/${String(installationId).trim()}/access_tokens`, {
    family: 'auth',
    essential: true,
    retryUnsafe: true,
    body: { repositories: [...repositories], permissions: { ...permissions } },
  });
  const data = res.data ?? {};
  if (!data.token) throw new Error('installation token response had no token');
  checkPermissions(permissions, data.permissions);
  const expiresAt = Date.parse(data.expires_at);
  return { token: data.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + 50 * 60_000, permissions: data.permissions ?? {} };
}

/**
 * A minter bound to the app's settings, for pump and watchdog. Reads APP_ID,
 * APP_INSTALLATION_ID and APP_PRIVATE_KEY from `env` unless given.
 */
export function appTokenMinter({ env = process.env, fetch, apiUrl, now, sleep, budget } = {}) {
  const appId = env.APP_ID;
  const installationId = env.APP_INSTALLATION_ID;
  const privateKey = env.APP_PRIVATE_KEY;
  const missing = [!appId && 'APP_ID', !installationId && 'APP_INSTALLATION_ID', !privateKey && 'APP_PRIVATE_KEY'].filter(Boolean);
  if (missing.length) throw new Error(`GitHub App settings missing: ${missing.join(', ')}`);
  return ({ repositories, permissions }) =>
    mintInstallationToken({ appId, privateKey, installationId, repositories, permissions, fetch, apiUrl, now, sleep, budget });
}
