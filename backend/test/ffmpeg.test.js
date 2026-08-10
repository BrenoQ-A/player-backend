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

    const progress = [];
    const info = await media.transcodeVideo(input, {
      keepOriginalAudio: true,
      onProgress: (event) => progress.push(event.percent)
    }, output);

    assert.equal(info.video.codec_name, 'h264');
    assert.equal(info.video.pix_fmt, 'yuv420p');
    assert.equal(info.video.sample_aspect_ratio, '1:1');
    assert.match(info.video.profile, /baseline|main/i);
    assert.ok(Number(info.video.level) <= 31);
    assert.equal(info.audio.codec_name, 'aac');
    assert.ok(info.video.width <= media.constants.MAX_WIDTH);
    assert.ok(info.video.height <= media.constants.MAX_HEIGHT);
    assert.ok(info.durationSeconds > 0);
    assert.ok(progress.length > 0);
    assert.equal(progress[progress.length - 1], 100);
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
      '-profile:v', 'main',
      '-level:v', '3.1',
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

test('reposiciona faststart sem recodificar vídeo compatível', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'player-ffmpeg-test-'));
  const input = path.join(dir, 'entrada-sem-faststart.mp4');
  const output = path.join(dir, 'saida-remux.mp4');

  try {
    await run([
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=size=640x360:rate=30',
      '-f', 'lavfi',
      '-i', 'sine=frequency=1000:sample_rate=44100',
      '-t', '1',
      '-c:v', 'libx264',
      '-profile:v', 'main',
      '-level:v', '3.1',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-ac', '2',
      input
    ]);

    const inputInfo = await media.probe(input);
    assert.equal(media.isSamsungCompatible(inputInfo), true);
    assert.equal(await media.hasFastStart(input), false);

    const progress = [];
    const outputInfo = await media.remuxVideo(input, {
      inputInfo,
      onProgress: (event) => progress.push(event.percent)
    }, output);
    assert.equal(outputInfo.video.codec_name, inputInfo.video.codec_name);
    assert.equal(outputInfo.video.width, inputInfo.video.width);
    assert.equal(outputInfo.video.height, inputInfo.video.height);
    assert.equal(outputInfo.audio.codec_name, 'aac');
    assert.equal(await media.hasFastStart(output), true);
    assert.equal(progress[progress.length - 1], 100);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mantém H.264 e converte somente áudio incompatível', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'player-ffmpeg-test-'));
  const input = path.join(dir, 'entrada-audio-incompativel.mkv');
  const output = path.join(dir, 'saida-audio-aac.mp4');

  try {
    await run([
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=size=640x360:rate=24',
      '-f', 'lavfi',
      '-i', 'sine=frequency=1000:sample_rate=44100',
      '-t', '1',
      '-c:v', 'libx264',
      '-profile:v', 'main',
      '-level:v', '3.1',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_s16le',
      input
    ]);

    const inputInfo = await media.probe(input);
    assert.equal(media.isSamsungVideoCompatible(inputInfo), true);
    assert.equal(media.isSamsungAudioCompatible(inputInfo), false);

    const outputInfo = await media.remuxVideo(input, {
      inputInfo,
      transcodeAudio: true
    }, output);
    assert.equal(outputInfo.video.codec_name, 'h264');
    assert.equal(outputInfo.audio.codec_name, 'aac');
    assert.equal(media.isSamsungCompatible(outputInfo), true);
    assert.equal(await media.hasFastStart(output), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rejeita 1080p, perfil High e bitrate excessivo para a Samsung UN32J4290', () => {
  const compatible = {
    bitRate: 2500000,
    video: {
      codec_name: 'h264',
      profile: 'Main',
      level: 31,
      width: 1280,
      height: 720,
      sample_aspect_ratio: '1:1',
      pix_fmt: 'yuv420p',
      avg_frame_rate: '30/1',
      bit_rate: '2300000'
    },
    audio: { codec_name: 'aac', channels: 2 }
  };

  assert.equal(media.isSamsungCompatible(compatible), true);
  assert.equal(media.isSamsungVideoCompatible({
    ...compatible,
    video: { ...compatible.video, width: 1920, height: 1080 }
  }), false);
  assert.equal(media.isSamsungVideoCompatible({
    ...compatible,
    video: { ...compatible.video, profile: 'High' }
  }), false);
  assert.equal(media.isSamsungVideoCompatible({
    ...compatible,
    video: {
      ...compatible.video,
      bit_rate: String(media.constants.MAX_COMPATIBLE_BITRATE + 1)
    }
  }), false);
  assert.equal(media.isSamsungVideoCompatible({
    ...compatible,
    video: { ...compatible.video, sample_aspect_ratio: '4:3' }
  }), false);
});

test('normaliza vídeo anamórfico para pixels quadrados sem deformar a imagem', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'player-ffmpeg-test-'));
  const input = path.join(dir, 'entrada-anamorfica.mp4');
  const output = path.join(dir, 'saida-quadrada.mp4');

  try {
    await run([
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=size=720x480:rate=24',
      '-t', '1',
      '-vf', 'setsar=32/27',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      input
    ]);

    const inputInfo = await media.probe(input);
    assert.equal(inputInfo.video.sample_aspect_ratio, '32:27');

    const info = await media.transcodeVideo(input, {}, output);
    const inputDisplayAspect = Number(inputInfo.video.display_aspect_ratio.split(':')[0]) /
      Number(inputInfo.video.display_aspect_ratio.split(':')[1]);
    const outputDisplayAspect = Number(info.video.display_aspect_ratio.split(':')[0]) /
      Number(info.video.display_aspect_ratio.split(':')[1]);

    assert.equal(info.video.sample_aspect_ratio, '1:1');
    assert.ok(Math.abs(inputDisplayAspect - outputDisplayAspect) < 0.01);
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
    const rateParts = info.video.avg_frame_rate.split('/');
    const frameRate = Number(rateParts[0]) / Number(rateParts[1] || 1);
    assert.ok(frameRate <= Number(media.constants.IMAGE_VIDEO_FPS));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
