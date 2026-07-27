// Wrapper fino sobre o ffmpeg para as duas operações que a etapa de
// processamento precisa: (1) transformar imagem + música em vídeo e
// (2) normalizar o volume do áudio dentro de uma faixa agradável.
'use strict';

const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// Alvo de volume: -16 LUFS integrado é o padrão usado por serviços de
// streaming (Spotify, YouTube) para conteúdo "confortável de ouvir" sem
// picos estourados nem trechos baixos demais. TP=-1.5 evita clipping de
// pico; LRA=11 evita que o normalizador achate demais a dinâmica.
// Isso funciona como a "régua" pedida: o que está mais baixo sobe até
// essa faixa, o que está mais alto desce até essa faixa.
const LOUDNESS_TARGET = 'loudnorm=I=-16:TP=-1.5:LRA=11';

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) { resolve(); }
      else { reject(new Error('ffmpeg falhou (código ' + code + '): ' + stderr.slice(-1500))); }
    });
  });
}

// Imagem parada + música (opcional) -> vídeo mp4 de duração fixa.
async function imageToVideo(imagePath, musicPath, durationSeconds, outPath) {
  const args = ['-y', '-loop', '1', '-i', imagePath];
  if (musicPath) { args.push('-stream_loop', '-1', '-i', musicPath); }
  args.push(
    '-t', String(durationSeconds),
    '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p'
  );
  if (musicPath) {
    args.push('-af', LOUDNESS_TARGET, '-shortest');
  } else {
    args.push('-an');
  }
  args.push(outPath);
  await run(args);
}

// Vídeo original + música nova no lugar do áudio original (silenciado).
async function replaceVideoAudioWithMusic(videoPath, musicPath, outPath) {
  await run([
    '-y', '-i', videoPath, '-stream_loop', '-1', '-i', musicPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-af', LOUDNESS_TARGET, '-shortest', outPath
  ]);
}

// Vídeo original silenciado, sem música nenhuma.
async function muteVideo(videoPath, outPath) {
  await run(['-y', '-i', videoPath, '-c:v', 'copy', '-an', outPath]);
}

// Vídeo original mantendo o áudio, só normalizando o volume.
async function normalizeVideoAudio(videoPath, outPath) {
  await run(['-y', '-i', videoPath, '-c:v', 'copy', '-af', LOUDNESS_TARGET, outPath]);
}

module.exports = { imageToVideo, replaceVideoAudioWithMusic, muteVideo, normalizeVideoAudio };
