'use strict';

const { spawn } = require('child_process');
const fs = require('fs/promises');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const LOUDNESS_TARGET = 'loudnorm=I=-16:TP=-1.5:LRA=11';
const FFMPEG_THREADS = process.env.FFMPEG_THREADS || '1';
const FFMPEG_PRESET = process.env.FFMPEG_PRESET || 'ultrafast';
const MAX_WIDTH = Number(process.env.FFMPEG_MAX_WIDTH || 1280);
const MAX_HEIGHT = Number(process.env.FFMPEG_MAX_HEIGHT || 720);
const VIDEO_FPS = process.env.FFMPEG_VIDEO_FPS || '30';
const IMAGE_VIDEO_FPS = process.env.IMAGE_VIDEO_FPS || '15';
const MAX_CAPTURE_CHARS = 20000;
const SCALE_FILTER =
  "scale=w='min(" + MAX_WIDTH + ",iw)':h='min(" + MAX_HEIGHT + ",ih)':" +
  'force_original_aspect_ratio=decrease:force_divisible_by=2';

const VIDEO_ARGS = [
  '-c:v', 'libx264',
  '-preset', FFMPEG_PRESET,
  '-tune', 'zerolatency',
  '-crf', process.env.FFMPEG_CRF || '23',
  '-profile:v', 'main',
  '-level:v', '4.0',
  '-pix_fmt', 'yuv420p',
  '-threads', FFMPEG_THREADS,
  '-maxrate', process.env.FFMPEG_MAXRATE || '3M',
  '-bufsize', process.env.FFMPEG_BUFSIZE || '6M',
  '-x264-params', 'rc-lookahead=0:sync-lookahead=0:bframes=0:sliced-threads=1',
  '-movflags', '+faststart'
];

const AUDIO_ARGS = [
  '-c:a', 'aac',
  '-b:a', process.env.FFMPEG_AUDIO_BITRATE || '160k',
  '-ac', '2',
  '-ar', '48000'
];

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const commandArgs = binary === ffmpegPath
      ? ['-hide_banner', '-loglevel', 'error', '-nostdin'].concat(args)
      : args;
    const proc = spawn(binary, commandArgs);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout = (stdout + data.toString()).slice(-MAX_CAPTURE_CHARS);
    });
    proc.stderr.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-MAX_CAPTURE_CHARS);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(
          'Processamento de mídia falhou (código ' + code + '): ' +
          stderr.slice(-2500)
        ));
      }
    });
  });
}

async function probe(filePath) {
  const result = await run(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration,size,bit_rate',
    '-show_entries',
    'stream=codec_type,codec_name,profile,level,width,height,pix_fmt,r_frame_rate,avg_frame_rate,bit_rate,sample_rate,channels',
    '-of', 'json',
    filePath
  ]);
  const data = JSON.parse(result.stdout);
  const streams = data.streams || [];
  const video = streams.find((stream) => stream.codec_type === 'video') || null;
  const audio = streams.find((stream) => stream.codec_type === 'audio') || null;
  return {
    durationSeconds: Number(data.format && data.format.duration) || null,
    sizeBytes: Number(data.format && data.format.size) || null,
    bitRate: Number(data.format && data.format.bit_rate) || null,
    video,
    audio
  };
}

function rateToNumber(rate) {
  const parts = String(rate || '').split('/');
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1] || 1);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

function isSamsungVideoCompatible(info) {
  const video = info && info.video;
  if (!video) { return false; }

  const frameRate = rateToNumber(video.avg_frame_rate || video.r_frame_rate);
  const bitRate = Number(video.bit_rate) || Number(info.bitRate) ||
    (Number(info.sizeBytes) * 8 / Number(info.durationSeconds));
  const profile = String(video.profile || '');

  return (
    video.codec_name === 'h264' &&
    /baseline|main|high/i.test(profile) &&
    Number(video.level) <= 41 &&
    Number(video.width) <= 1920 &&
    Number(video.height) <= 1080 &&
    video.pix_fmt === 'yuv420p' &&
    frameRate > 0 &&
    frameRate <= 30.01 &&
    bitRate > 0 &&
    bitRate <= 30000000
  );
}

function isSamsungAudioCompatible(info) {
  const audio = info && info.audio;
  return !audio || (
    audio.codec_name === 'aac' &&
    (!audio.channels || Number(audio.channels) <= 2)
  );
}

function isSamsungCompatible(info) {
  return isSamsungVideoCompatible(info) && isSamsungAudioCompatible(info);
}

async function hasFastStart(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024));
    await handle.read(buffer, 0, buffer.length, 0);
    const moovIndex = buffer.indexOf('moov');
    const mdatIndex = buffer.indexOf('mdat');
    return moovIndex >= 0 && (mdatIndex < 0 || moovIndex < mdatIndex);
  } finally {
    await handle.close();
  }
}

function videoOutputArgs(frameRate) {
  return ['-filter_threads', FFMPEG_THREADS, '-vf', SCALE_FILTER]
    .concat(VIDEO_ARGS)
    .concat(['-r', String(frameRate || VIDEO_FPS)]);
}

async function imageToVideo(imagePath, musicPath, durationSeconds, outPath) {
  const args = [
    '-y',
    '-loop', '1',
    '-framerate', IMAGE_VIDEO_FPS,
    '-i', imagePath
  ];

  if (musicPath) {
    args.push('-stream_loop', '-1', '-i', musicPath);
  }

  args.push('-t', String(durationSeconds));
  args.push.apply(args, videoOutputArgs(IMAGE_VIDEO_FPS));

  if (musicPath) {
    args.push('-map', '0:v:0', '-map', '1:a:0');
    args.push('-af', LOUDNESS_TARGET);
    args.push.apply(args, AUDIO_ARGS);
    args.push('-shortest');
  } else {
    args.push('-an');
  }

  args.push(outPath);
  await run(ffmpegPath, args);
  return probe(outPath);
}

async function transcodeVideo(videoPath, options, outPath) {
  const opts = options || {};
  const inputInfo = opts.inputInfo || await probe(videoPath);
  const args = ['-y', '-i', videoPath];

  if (opts.musicPath) {
    args.push('-stream_loop', '-1', '-i', opts.musicPath);
  }

  args.push('-map', '0:v:0');
  args.push.apply(args, videoOutputArgs(VIDEO_FPS));

  if (opts.keepOriginalAudio && inputInfo.audio) {
    args.push('-map', '0:a:0');
    args.push('-af', LOUDNESS_TARGET);
    args.push.apply(args, AUDIO_ARGS);
  } else if (opts.musicPath) {
    args.push('-map', '1:a:0');
    args.push('-af', LOUDNESS_TARGET);
    args.push.apply(args, AUDIO_ARGS);
    args.push('-shortest');
  } else {
    args.push('-an');
  }

  args.push(outPath);
  await run(ffmpegPath, args);
  return probe(outPath);
}

async function remuxVideo(videoPath, options, outPath) {
  const opts = options || {};
  const inputInfo = opts.inputInfo || await probe(videoPath);
  const args = [
    '-y',
    '-i', videoPath,
    '-map', '0:v:0',
    '-c:v', 'copy'
  ];

  if (inputInfo.audio) {
    args.push('-map', '0:a:0');
    if (opts.transcodeAudio) {
      args.push.apply(args, AUDIO_ARGS);
    } else {
      args.push('-c:a', 'copy');
    }
  } else {
    args.push('-an');
  }

  args.push('-movflags', '+faststart', outPath);
  await run(ffmpegPath, args);
  return probe(outPath);
}

module.exports = {
  imageToVideo,
  transcodeVideo,
  remuxVideo,
  probe,
  isSamsungVideoCompatible,
  isSamsungAudioCompatible,
  isSamsungCompatible,
  hasFastStart,
  constants: {
    SCALE_FILTER,
    VIDEO_ARGS,
    AUDIO_ARGS,
    FFMPEG_PRESET,
    MAX_WIDTH,
    MAX_HEIGHT,
    VIDEO_FPS,
    IMAGE_VIDEO_FPS
  }
};
