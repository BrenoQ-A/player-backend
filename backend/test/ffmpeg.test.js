'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const media = require('../ffmpeg');

function run(args) {
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

test('converte vídeo incompatível para H.264/AAC da Samsung 2015', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'player-ffmpeg-test-'));
  const input = path.join(dir, 'entrada.avi');
  const output = path.join(dir, 'saida.mp4');

  try {
    await run([
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=size=640x360:rate=24',
      '-f', 'lavfi',
      '-i', 'sine=frequency=1000:sample_rate=44100',
      '-t', '1.2',
      '-c:v', 'mpeg4',
      '-c:a', 'pcm_s16le',
      input
    ]);

    const inputInfo = await media.probe(input);
    assert.equal(media.isSamsungCompatible(inputInfo), false);

    const info = await media.transcodeVideo(input, {
      keepOriginalAudio: true
    }, output);

    assert.equal(info.video.codec_name, 'h264');
    assert.equal(info.video.pix_fmt, 'yuv420p');
    assert.equal(info.audio.codec_name, 'aac');
    assert.ok(info.video.width <= 1920);
    assert.ok(info.video.height <= 1080);
    assert.ok(info.durationSeconds > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('reconhece MP4 já compatível e com faststart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'player-ffmpeg-test-'));
  const input = path.join(dir, 'entrada-compativel.mp4');

  try {
    await run([
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=size=640x360:rate=30',
      '-f', 'lavfi',
      '-i', 'sine=frequency=1000:sample_rate=44100',
      '-t', '1',
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-level:v', '4.0',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-ac', '2',
      '-movflags', '+faststart',
      input
    ]);

    const info = await media.probe(input);
    assert.equal(media.isSamsungCompatible(info), true);
    assert.equal(await media.hasFastStart(input), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('transforma imagem em vídeo H.264 de duração configurada', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'player-ffmpeg-test-'));
  const input = path.join(dir, 'entrada.png');
  const output = path.join(dir, 'saida.mp4');

  try {
    await run([
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=blue:size=853x479',
      '-frames:v', '1',
      input
    ]);

    const info = await media.imageToVideo(input, null, 1, output);
    assert.equal(info.video.codec_name, 'h264');
    assert.equal(info.video.pix_fmt, 'yuv420p');
    assert.equal(info.audio, null);
    assert.ok(info.durationSeconds >= 0.9);
    assert.equal(info.video.width % 2, 0);
    assert.equal(info.video.height % 2, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
