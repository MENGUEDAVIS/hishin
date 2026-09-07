import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { apiRouter } from '../../src/server/routes.ts';
import { recordProjectOwnerIfAbsent } from '../../src/state/ownership.ts';
import { withinDirectory } from '../../src/server/access.ts';

test('production authentication and two-user isolation fail closed for all project resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hishin-auth-'));
  const saved = { ...process.env };
  Object.assign(process.env, { DATA_DIR: directory, NODE_ENV: 'production', AUTH_MODE: 'alb', APP_ORIGIN: 'https://hishin.globalnavigator.app', ALB_ARN: 'test-alb', COGNITO_CLIENT_ID: 'test-client' });
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).startsWith('https://public-keys.auth.elb.')
    ? new Response(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString())
    : originalFetch(input, init);
  const token = (id: string, signer = 'test-alb', exp = Math.floor(Date.now() / 1000) + 300) => jwt.sign({ sub: id, email: `${id}@example.invalid` }, keys.privateKey, {
    algorithm: 'ES256', header: { alg: 'ES256', kid: 'test-key', signer, client: 'test-client', exp } as jwt.JwtHeader,
  });
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function request(path: string, credential = token('alice'), init: RequestInit = {}) {
    return originalFetch(base + path, { ...init, headers: { 'x-amzn-oidc-data': credential, ...init.headers } });
  }
  try {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64').replaceAll('+', '-').replaceAll('/', '_');
    const paddedHeader = encode({ alg: 'ES256', kid: 'test-key', signer: 'test-alb', client: 'test-client', exp: Math.floor(Date.now() / 1000) + 300 });
    const paddedPayload = encode({ sub: 'alice', email: 'alice@example.invalid' });
    const signingInput = `${paddedHeader}.${paddedPayload}`;
    const signature = sign('sha256', Buffer.from(signingInput), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    assert.equal((await request('/api/me', `${signingInput}.${signature}`)).status, 200);
    assert.equal((await request('/api/me', `${paddedHeader}.${encode({ sub: 'bob' })}.${signature}`)).status, 401);
    for (const [id, owner] of [['alice_project', 'alice'], ['bob_project', 'bob']] as const) {
      const raw = join(directory, 'projects', id, 'raw');
      await mkdir(raw, { recursive: true });
      await writeFile(join(raw, 'manifest.json'), JSON.stringify({ projectId: id, takes: [] }));
      await writeFile(join(raw, 'video.mp4'), 'test-media');
      await recordProjectOwnerIfAbsent(id, owner);
    }
    await recordProjectOwnerIfAbsent('bob_project', 'alice');
    assert.equal((await request('/api/me', '')).status, 401);
    assert.equal((await request('/api/me', token('alice', 'other-alb'))).status, 401);
    assert.equal((await request('/api/me', token('alice', 'test-alb', 1))).status, 401);
    // Explicitly disabled authentication must not bypass verification in production.
    process.env.AUTH_MODE = 'disabled';
    assert.equal((await request('/api/me', '')).status, 401);
    process.env.AUTH_MODE = 'alb';
    const library = await (await request('/api/library')).json();
    assert.deepEqual(library.projects.map((p: { projectId: string }) => p.projectId), ['alice_project']);
    for (const suffix of ['', '/runs', '/runs/secret', '/traces', '/costs']) {
      assert.equal((await request(`/api/projects/bob_project${suffix}`)).status, 404);
    }
    assert.equal((await request('/api/projects/bob_project/runs', token('alice'), { method: 'POST', headers: { origin: process.env.APP_ORIGIN! } })).status, 404);
    assert.equal((await request('/api/projects/alice_project')).status, 200);
    assert.equal((await request('/api/projects/alice_project', token('bob'))).status, 404);
    assert.equal((await request('/api/projects', token('alice'), { method: 'POST' })).status, 403);
    assert.equal((await request('/api/projects', token('alice'), { method: 'POST', headers: { origin: process.env.APP_ORIGIN! } })).status, 403);
    const ownFile = join(directory, 'projects/alice_project/raw/video.mp4');
    const otherFile = join(directory, 'projects/bob_project/raw/video.mp4');
    assert.equal((await request(`/api/media?path=${encodeURIComponent(ownFile)}`)).status, 200);
    assert.equal((await request(`/api/media?path=${encodeURIComponent(otherFile)}`)).status, 404);
    assert.equal((await request(`/api/media?path=${encodeURIComponent(join(directory, 'app.sqlite'))}`)).status, 404);
    const link = join(directory, 'projects/alice_project/raw/link.mp4');
    await symlink(otherFile, link);
    assert.equal((await request(`/api/media?path=${encodeURIComponent(link)}`)).status, 404);
    await assert.rejects(withinDirectory(join(directory, 'projects/alice_project'), otherFile));
    await assert.rejects(withinDirectory(join(directory, 'projects/alice_project'), link));
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    globalThis.fetch = originalFetch;
    process.env = saved;
    await rm(directory, { recursive: true, force: true });
  }
});
