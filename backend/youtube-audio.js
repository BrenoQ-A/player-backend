'use strict';

const fs = require('fs/promises');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');

const MAX_COOKIE_FILE_BYTES = 1024 * 1024;
const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be'
]);

function userError(message, code) {
  const error = new Error(message);
  error.status = 422;
  error.code = code || 'YOUTUBE_AUDIO_INVALID';
  return error;
}

function serviceError(message, code) {
  const error = new Error(message);
  error.status = 503;
  error.code = code || 'YOUTUBE_AUDIO_UNAVAILABLE';
  return error;
}

function validateYouTubeUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (error) {
    throw userError('Informe um link válido de um vídeo do YouTube.');
  }

  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw userError('Use um link HTTPS dos domínios youtube.com ou youtu.be.');
  }
  if (parsed.searchParams.has('list')) {
    throw userError('Envie o link de um único vídeo. Playlists não são aceitas.');
  }

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  const hasVideo =
    (host === 'youtu.be' && segments.length === 1) ||
    (host !== 'youtu.be' && (
      (parsed.pathname === '/watch' && parsed.searchParams.has('v')) ||
      (['shorts', 'live', 'embed'].includes(segments[0]) && !!segments[1])
    ));
  if (!hasVideo) {
    throw userError('O link não identifica um vídeo individual do YouTube.');
  }

  parsed.hash = '';
  return parsed.toString();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function friendlyExtractionError(error, context) {
  if (error && error.status) { return error; }
  const hasCookies = Boolean(context && context.hasCookies);
  const details = String(
    (error && (error.stderr || error.message)) || ''
  ).toLowerCase();

  if (
    details.includes('sign in to confirm') ||
    details.includes('not a bot') ||
    details.includes('bot detection')
  ) {
    if (hasCookies) {
      return serviceError(
        'O YouTube rejeitou a sessão configurada no servidor. Atualize os cookies do YouTube no Render.',
        'YOUTUBE_COOKIES_EXPIRED'
      );
    }
    return serviceError(
      'O YouTube bloqueou o IP do servidor. Configure a credencial YOUTUBE_COOKIES_BASE64 no Render.',
      'YOUTUBE_COOKIES_REQUIRED'
    );
  }
  if (details.includes('private video') || details.includes('video unavailable')) {
    return userError(
      'O vídeo está indisponível ou não é público.',
      'YOUTUBE_VIDEO_UNAVAILABLE'
    );
  }
  if (details.includes('copyright') || details.includes('members-only')) {
    return userError(
      'O YouTube não permite acessar esse vídeo.',
      'YOUTUBE_VIDEO_RESTRICTED'
    );
  }
  if (
    (error && error.signalCode) ||
    details.includes('timed out') ||
    details.includes('timeout')
  ) {
    return userError(
      'A extração demorou além do limite do servidor. Tente novamente.',
      'YOUTUBE_AUDIO_TIMEOUT'
    );
  }
  return userError(
    'Não foi possível extrair o áudio desse vídeo do YouTube.',
    'YOUTUBE_EXTRACTION_FAILED'
  );
}

function decodeCookieFile(encodedValue) {
  const compactValue = String(encodedValue || '').replace(/\s+/g, '');
  if (!compactValue) { return null; }
  if (
    compactValue.length > MAX_COOKIE_FILE_BYTES * 2 ||
    compactValue.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compactValue)
  ) {
    throw serviceError(
      'A credencial YOUTUBE_COOKIES_BASE64 não contém um arquivo cookies.txt válido.',
      'YOUTUBE_COOKIES_INVALID'
    );
  }

  const decoded = Buffer.from(compactValue, 'base64');
  if (!decoded.length || decoded.length > MAX_COOKIE_FILE_BYTES) {
    throw serviceError(
      'A credencial YOUTUBE_COOKIES_BASE64 excede o tamanho permitido ou está vazia.',
      'YOUTUBE_COOKIES_INVALID'
    );
  }

  const contents = decoded.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = contents.split('\n');
  const header = String(lines[0] || '').trim();
  const hasValidHeader =
    header === '# Netscape HTTP Cookie File' ||
    header === '# HTTP Cookie File';
  const hasYouTubeCookie = lines.some((line) => {
    const value = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
    if (!value || value.startsWith('#')) { return false; }
    const fields = value.split('\t');
    const domain = String(fields[0] || '').replace(/^\./, '').toLowerCase();
    return fields.length >= 7 && (domain === 'youtube.com' || domain.endsWith('.youtube.com'));
  });

  if (!hasValidHeader || !hasYouTubeCookie) {
    throw serviceError(
      'A credencial YOUTUBE_COOKIES_BASE64 deve ser um cookies.txt Netscape exportado para youtube.com.',
      'YOUTUBE_COOKIES_INVALID'
    );
  }

  return contents;
}

async function prepareCookieFile(dir, encodedValue) {
  const contents = decodeCookieFile(encodedValue);
  if (!contents) { return null; }
  const cookiePath = path.join(dir, 'youtube-cookies.txt');
  await fs.writeFile(cookiePath, contents, { encoding: 'utf8', mode: 0o600 });
  return cookiePath;
}

async function findExtractedMp3(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const match = entries.find((entry) => entry.isFile() && /\.mp3$/i.test(entry.name));
  if (!match) {
    throw userError(
      'O YouTube não forneceu um áudio que pudesse ser convertido para MP3.',
      'YOUTUBE_AUDIO_NOT_CREATED'
    );
  }
  return path.join(dir, match.name);
}

async function extractYouTubeAudio(value, dir, options) {
  const opts = options || {};
  const run = opts.run || youtubedl;
  const url = validateYouTubeUrl(value);
  const maxDurationMinutes = positiveNumber(
    opts.maxDurationMinutes || process.env.YOUTUBE_AUDIO_MAX_MINUTES,
    60
  );
  const maxOutputMb = positiveNumber(
    opts.maxOutputMb || process.env.YOUTUBE_AUDIO_MAX_MB,
    100
  );
  const timeoutMs = positiveNumber(
    opts.timeoutMs || process.env.YOUTUBE_AUDIO_TIMEOUT_MS,
    180000
  );
  const jsRuntime = String(
    opts.jsRuntime || process.env.YOUTUBE_JS_RUNTIME || 'node'
  ).trim() || 'node';
  const cookiesBase64 = opts.cookiesBase64 !== undefined
    ? opts.cookiesBase64
    : process.env.YOUTUBE_COOKIES_BASE64;
  const spawnOptions = { timeout: timeoutMs, killSignal: 'SIGKILL' };
  let cookiePath = null;

  try {
    cookiePath = await prepareCookieFile(dir, cookiesBase64);
    const commonFlags = {
      jsRuntimes: jsRuntime,
      ...(cookiePath ? { cookies: cookiePath } : {})
    };
    const metadata = await run(url, {
      ...commonFlags,
      dumpSingleJson: true,
      skipDownload: true,
      noPlaylist: true,
      noWarnings: true
    }, spawnOptions);
    const durationSeconds = Number(metadata && metadata.duration);

    if (!metadata || !metadata.id || !metadata.title) {
      throw userError(
        'Não foi possível ler as informações desse vídeo.',
        'YOUTUBE_METADATA_INVALID'
      );
    }
    if (metadata.is_live || metadata.live_status === 'is_live') {
      throw userError(
        'Transmissões ao vivo não são aceitas.',
        'YOUTUBE_LIVE_NOT_SUPPORTED'
      );
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw userError(
        'Não foi possível identificar a duração do vídeo.',
        'YOUTUBE_DURATION_UNKNOWN'
      );
    }
    if (durationSeconds > maxDurationMinutes * 60) {
      throw userError(
        'O vídeo ultrapassa o limite de ' + maxDurationMinutes + ' minutos.',
        'YOUTUBE_DURATION_LIMIT'
      );
    }

    const outputTemplate = path.join(dir, 'youtube-audio.%(ext)s');
    await run(url, {
      ...commonFlags,
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '5',
      noPlaylist: true,
      noWarnings: true,
      ffmpegLocation: ffmpegPath,
      maxFilesize: maxOutputMb + 'M',
      output: outputTemplate
    }, spawnOptions);

    const filePath = await findExtractedMp3(dir);
    const stat = await fs.stat(filePath);
    if (stat.size > maxOutputMb * 1024 * 1024) {
      throw userError(
        'O áudio gerado ultrapassa o limite de ' + maxOutputMb + ' MB.',
        'YOUTUBE_AUDIO_SIZE_LIMIT'
      );
    }

    return {
      filePath,
      title: String(metadata.title).trim(),
      sourceId: String(metadata.id),
      sourceUrl: url,
      durationSeconds: Math.round(durationSeconds),
      sizeBytes: stat.size
    };
  } catch (error) {
    throw friendlyExtractionError(error, { hasCookies: Boolean(cookiePath) });
  } finally {
    if (cookiePath) {
      await fs.rm(cookiePath, { force: true }).catch(() => {});
    }
  }
}

module.exports = {
  decodeCookieFile,
  extractYouTubeAudio,
  validateYouTubeUrl,
  friendlyExtractionError
};
