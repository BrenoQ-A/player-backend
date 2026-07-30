'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const bcrypt = require('bcryptjs');
process.env.GITHUB_TOKEN = 'test';
process.env.PRIVATE_REPO = 'test/private';
process.env.JWT_SECRET = '01234567890123456789012345678901';
process.env.INVITE_CODE = 'test';
process.env.ALLOWED_ORIGIN = 'http://localhost:8080';
process.env.STORAGE_DRIVER = 'local';
process.env.ADMIN_GPIDS = 'ADMIN001';
const gh = require('../github');
let users = [];
let usersSha = 'users-1';
gh.getContents = async (repo, filePath) => filePath === 'users.json' ? {
  sha: usersSha,
  content: Buffer.from(JSON.stringify(users)).toString('base64')
} : null;
gh.putContents = async (repo, filePath, branch, content) => {
  users = JSON.parse(String(content));
  usersSha = 'users-' + (Number(usersSha.split('-')[1]) + 1);
  return { content: { sha: usersSha } };
};
const { createApp } = require('../server');
async function post(baseUrl, route, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(baseUrl + route, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  return { response, data: await response.json() };
}
test('redefine senha e invalida a sessão anterior', async (t) => {
  users = [
    { gpid: 'ADMIN001', passwordHash: await bcrypt.hash('senha-admin', 4), authVersion: 1 },
    { gpid: 'USUARIO1', passwordHash: await bcrypt.hash('senha-antiga', 4), authVersion: 1 }
  ];
  const { app } = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const admin = await post(baseUrl, '/api/auth/login', { gpid: 'ADMIN001', password: 'senha-admin' });
  const oldLogin = await post(baseUrl, '/api/auth/login', { gpid: 'USUARIO1', password: 'senha-antiga' });
  const generated = await post(baseUrl, '/api/admin/password-resets',
    { gpid: 'USUARIO1' }, admin.data.token);
  assert.equal(generated.response.status, 200);
  assert.equal(users[1].passwordReset.digest.includes(generated.data.resetCode), false);
  const reset = await post(baseUrl, '/api/auth/reset-password', {
    gpid: 'USUARIO1', resetCode: generated.data.resetCode, password: 'senha-nova-segura'
  });
  assert.equal(reset.response.status, 200);
  assert.equal(users[1].authVersion, 2);
  const oldSession = await fetch(baseUrl + '/api/auth/session', {
    headers: { Authorization: 'Bearer ' + oldLogin.data.token }
  });
  assert.equal(oldSession.status, 401);
});
