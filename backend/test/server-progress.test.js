'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const jwt = require('jsonwebtoken');

const TEST_SECRET = '01234567890123456789012345678901';
process.env.GITHUB_TOKEN = 'test';
process.env.PRIVATE_REPO = 'test/private';
process.env.JWT_SECRET = TEST_SECRET;
process.env.INVITE_CODE = 'test';
process.env.ALLOWED_ORIGIN = 'http://localhost:8080';
process.env.STORAGE_DRIVER = 'local';

const gh = require('../github');
gh.getContents = async function getTestUsers(repo, filePath) {
  if (filePath !== 'users.json') return null;
  return {
    sha: 'users-test-sha',
    content: Buffer.from(JSON.stringify([
      { gpid: 'TESTUSER', authVersion: 1 },
      { gpid: 'OUTRO', authVersion: 1 }
    ])).toString('base64')
  };
};
const { createApp } = require('../server');

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) { resolve(); }
      else { reject(new Error(stderr)); }
    });
  });
}

test('expõe o resultado do progresso para o upload autenticado', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'player-progress-test-'));
  const input = path.join(dir, 'entrada.avi');
  process.env.STORAGE_LOCAL_DIR = path.join(dir, 'storage');
  let server;

  try {
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=size=320x180:rate=24',
      '-t', '0.5',
      '-c:v', 'mpeg4',
      '-an',
      input
    ]);

    const { app } = createApp();
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const token = jwt.sign({ gpid: 'TESTUSER' }, TEST_SECRET, { expiresIn: '5m' });
    const uploadId = 'upload-integration-12345678';
    const form = new FormData();
    form.append(
      'file',
      new Blob([await fs.readFile(input)], { type: 'video/x-msvideo' }),
      'entrada.avi'
    );

    const uploadResponse = await fetch(baseUrl + '/api/media/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'X-Upload-ID': uploadId
      },
      body: form
    });
    assert.equal(uploadResponse.status, 200);
    const uploaded = await uploadResponse.json();
    assert.equal(uploaded.processing, 'transcoded');

    const progressResponse = await fetch(
      baseUrl + '/api/media/progress/' + uploadId,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    assert.equal(progressResponse.status, 200);
    const data = await progressResponse.json();
    assert.equal(data.progress.stage, 'complete');
    assert.equal(data.progress.percent, 100);
    assert.equal(data.progress.processing, 'transcoded');

    const otherToken = jwt.sign({ gpid: 'OUTRO' }, TEST_SECRET, { expiresIn: '5m' });
    const forbiddenResponse = await fetch(
      baseUrl + '/api/media/progress/' + uploadId,
      { headers: { Authorization: 'Bearer ' + otherToken } }
    );
    assert.equal(forbiddenResponse.status, 404);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
