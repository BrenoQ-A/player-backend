'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  extractYouTubeAudio,
  validateYouTubeUrl
} = require('../youtube-audio');

test('aceita links de vídeos individuais do YouTube', () => {
  assert.equal(
    validateYouTubeUrl('https://www.youtube.com/watch?v=abc123'),
    'https://www.youtube.com/watch?v=abc123'
  );
  assert.equal(
    validateYouTubeUrl('https://youtu.be/abc123?t=10'),
    'https://youtu.be/abc123?t=10'
  );
  assert.equal(
    validateYouTubeUrl('https://music.youtube.com/watch?v=abc123'),
    'https://music.youtube.com/watch?v=abc123'
  );
  assert.equal(
    validateYouTubeUrl('https://www.youtube.com/shorts/abc123'),
    'https://www.youtube.com/shorts/abc123'
  );
});

test('bloqueia URLs inseguras, domínios parecidos e playlists', () => {
  assert.throws(
    () => validateYouTubeUrl('http://youtube.com/watch?v=abc123'),
    /link HTTPS/
  );
  assert.throws(
    () => validateYouTubeUrl('https://youtube.com.example.org/watch?v=abc123'),
    /youtube\.com/
  );
  assert.throws(
    () => validateYouTubeUrl('https://www.youtube.com/watch?v=abc123&list=playlist'),
    /Playlists/
  );
  assert.throws(
    () => validateYouTubeUrl('https://www.youtube.com/'),
    /vídeo individual/
  );
});

test('extrai MP3 usando metadados validados', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-audio-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];

  async function run(url, flags) {
    calls.push({ url, flags });
    if (flags.skipDownload) {
      return { id: 'abc123', title: 'Faixa de teste', duration: 125 };
    }
    await fs.writeFile(path.join(dir, 'youtube-audio.mp3'), Buffer.from('audio'));
    return '';
  }

  const result = await extractYouTubeAudio(
    'https://youtu.be/abc123',
    dir,
    { run, maxDurationMinutes: 10, maxOutputMb: 1, timeoutMs: 1000 }
  );

  assert.equal(result.title, 'Faixa de teste');
  assert.equal(result.durationSeconds, 125);
  assert.equal(result.sourceId, 'abc123');
  assert.equal(result.sizeBytes, 5);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].flags.skipDownload, true);
  assert.equal(calls[1].flags.extractAudio, true);
  assert.equal(calls[1].flags.audioFormat, 'mp3');
  assert.ok(calls[1].flags.ffmpegLocation);
});

test('recusa transmissão ao vivo e vídeo acima do limite', async () => {
  await assert.rejects(
    extractYouTubeAudio(
      'https://youtu.be/live123',
      os.tmpdir(),
      {
        run: async () => ({
          id: 'live123',
          title: 'Ao vivo',
          duration: 100,
          is_live: true
        })
      }
    ),
    (error) => error.code === 'YOUTUBE_LIVE_NOT_SUPPORTED'
  );

  await assert.rejects(
    extractYouTubeAudio(
      'https://youtu.be/long123',
      os.tmpdir(),
      {
        maxDurationMinutes: 1,
        run: async () => ({
          id: 'long123',
          title: 'Muito longo',
          duration: 61
        })
      }
    ),
    (error) => error.code === 'YOUTUBE_DURATION_LIMIT'
  );
});
