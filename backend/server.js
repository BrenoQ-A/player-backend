'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const gh = require('./github');
const ffmpeg = require('./ffmpeg');
const { createStorage } = require('./storage');
const { createCatalog } = require('./catalog');

const {
  GITHUB_TOKEN,
  PRIVATE_REPO,
  PRIVATE_BRANCH = 'main',
  JWT_SECRET,
  INVITE_CODE,
  ALLOWED_ORIGIN,
  PORT = 3000
} = process.env;

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const MAX_OUTPUT_MB = Number(process.env.MAX_OUTPUT_MB || 1000);
const SESSION_DAYS = 30;
const USERS_PATH = 'users.json';
const IMAGE_EXT = ['jpg', 'jpeg', 'png'];
const VIDEO_EXT = ['mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'mpeg', 'mpg'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'];

const DEFAULT_CONFIG = {
  imageDurationSeconds: 15,
  pollIntervalMinutes: 5,
  startMuted: false,
  showHud: true,
  autoReloadHours: 6,
  targetVolume: 0.8,
  videoVolumeOverrides: {},
  fillBorderColor: true,
  musicEnabled: false,
  musicPlaylist: [],
  imageMusicDurationSeconds: 40,
  musicVolume: 0.5
};

function validateEnvironment() {
  const required = { GITHUB_TOKEN, PRIVATE_REPO, JWT_SECRET, INVITE_CODE, ALLOWED_ORIGIN };
  const missing = Object.entries(required)
    .filter((entry) => !entry[1])
    .map((entry) => entry[0]);
  if (missing.length) {
    throw new Error('Variáveis de ambiente ausentes: ' + missing.join(', '));
  }
}

function extOf(name) {
  const parts = String(name || '').split('.');
  return parts.length < 2 ? '' : parts[parts.length - 1].toLowerCase();
}

function safeBaseName(originalName) {
  const noExt = String(originalName || '').replace(/\.[^./\\]+$/, '');
  const normalized = noExt.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return normalized
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 100) || 'midia';
}

function contentTypeForAudio(extension) {
  const map = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac'
  };
  return map[extension] || 'application/octet-stream';
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) { return fallback; }
  return Math.min(max, Math.max(min, number));
}

function sanitizeConfig(body) {
  const source = body || {};
  const overrides =
    source.videoVolumeOverrides &&
    typeof source.videoVolumeOverrides === 'object' &&
    !Array.isArray(source.videoVolumeOverrides)
      ? source.videoVolumeOverrides
      : {};

  return {
    imageDurationSeconds: clampNumber(source.imageDurationSeconds, 15, 1, 3600),
    pollIntervalMinutes: clampNumber(source.pollIntervalMinutes, 5, 1, 1440),
    startMuted: !!source.startMuted,
    showHud: !!source.showHud,
    autoReloadHours: clampNumber(source.autoReloadHours, 6, 0, 168),
    targetVolume: clampNumber(source.targetVolume, 0.8, 0, 1),
    videoVolumeOverrides: overrides,
    fillBorderColor: !!source.fillBorderColor,
    musicEnabled: !!source.musicEnabled,
    musicPlaylist: Array.isArray(source.musicPlaylist) ? source.musicPlaylist : [],
    imageMusicDurationSeconds: clampNumber(source.imageMusicDurationSeconds, 40, 1, 3600),
    musicVolume: clampNumber(source.musicVolume, 0.5, 0, 1)
  };
}

async function loadUsers() {
  const file = await gh.getContents(PRIVATE_REPO, USERS_PATH, PRIVATE_BRANCH);
  if (!file) { return { users: [], sha: null }; }
  const decoded = Buffer.from(file.content, 'base64').toString('utf8');
  return { users: JSON.parse(decoded), sha: file.sha };
}

async function saveUsers(users, sha, message) {
  const result = await gh.putContents(
    PRIVATE_REPO,
    USERS_PATH,
    PRIVATE_BRANCH,
    JSON.stringify(users, null, 2),
    message,
    sha || undefined
  );
  return result.content.sha;
}

function issueToken(res, gpid) {
  const token = jwt.sign({ gpid }, JWT_SECRET, { expiresIn: SESSION_DAYS + 'd' });
  res.cookie('session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
  return token;
}

function requireAuth(req, res, next) {
  const authorization = req.get('authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  const token = bearer || (req.cookies && req.cookies.session);
  if (!token) {
    return res.status(401).json({ error: 'Não autenticado.', code: 'AUTH_REQUIRED' });
  }
  try {
    req.gpid = jwt.verify(token, JWT_SECRET).gpid;
    next();
  } catch (error) {
    res.status(401).json({
      error: 'Sessão expirada, faça login novamente.',
      code: 'AUTH_EXPIRED'
    });
  }
}

function asyncRoute(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function withTempDir(fn) {
  const dir = path.join(os.tmpdir(), 'player-process-' + crypto.randomUUID());
  await fs.mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function removeUploadedFiles(files) {
  const list = Array.isArray(files) ? files : (files ? [files] : []);
  await Promise.all(list.map((file) => fs.unlink(file.path).catch(() => {})));
}

function createApp() {
  validateEnvironment();

  const storage = createStorage();
  const catalog = createCatalog(storage);
  const app = express();
  const uploadDir = path.join(os.tmpdir(), 'player-uploads');
  const allowedOrigins = ALLOWED_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean);

  const upload = multer({
    storage: multer.diskStorage({
      destination: function destination(req, file, callback) {
        fs.mkdir(uploadDir, { recursive: true })
          .then(() => callback(null, uploadDir))
          .catch(callback);
      },
      filename: function filename(req, file, callback) {
        const extension = path.extname(file.originalname || '').toLowerCase();
        callback(null, crypto.randomUUID() + extension);
      }
    }),
    limits: {
      fileSize: MAX_UPLOAD_MB * 1024 * 1024,
      files: 20
    }
  });

  app.disable('x-powered-by');
  app.use(function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(cors({
    credentials: true,
    origin: function origin(requestOrigin, callback) {
      if (!requestOrigin || allowedOrigins.includes(requestOrigin)) {
        callback(null, requestOrigin || allowedOrigins[0]);
      } else {
        callback(new Error('Origem não autorizada: ' + requestOrigin));
      }
    }
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));

  if (storage.driver === 'local') {
    app.use('/storage', express.static(storage.localDir, {
      acceptRanges: true,
      etag: true,
      maxAge: '1h'
    }));
  }

  app.get('/health', function health(req, res) {
    res.json({
      ok: true,
      service: 'player-sinalizacao-backend',
      storage: storage.driver,
      timestamp: new Date().toISOString()
    });
  });

  app.post('/api/auth/register', asyncRoute(async (req, res) => {
    const { gpid, password, inviteCode } = req.body || {};
    if (!gpid || !password) {
      return res.status(400).json({ error: 'GPID e senha são obrigatórios.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    }
    if (inviteCode !== INVITE_CODE) {
      return res.status(403).json({ error: 'Código de convite do time inválido.' });
    }

    const { users, sha } = await loadUsers();
    const gpidNorm = String(gpid).trim().toUpperCase();
    if (users.find((user) => user.gpid === gpidNorm)) {
      return res.status(409).json({ error: 'Esse GPID já tem cadastro. Faça login.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    users.push({ gpid: gpidNorm, passwordHash, createdAt: new Date().toISOString() });
    await saveUsers(users, sha, 'Novo usuário: ' + gpidNorm);
    const token = issueToken(res, gpidNorm);
    res.json({ gpid: gpidNorm, token });
  }));

  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const { gpid, password } = req.body || {};
    if (!gpid || !password) {
      return res.status(400).json({ error: 'GPID e senha são obrigatórios.' });
    }

    const gpidNorm = String(gpid).trim().toUpperCase();
    const { users } = await loadUsers();
    const user = users.find((candidate) => candidate.gpid === gpidNorm);
    const valid = user && await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'GPID ou senha incorretos.' });
    }

    const token = issueToken(res, gpidNorm);
    res.json({ gpid: gpidNorm, token });
  }));

  app.post('/api/auth/logout', function logout(req, res) {
    res.clearCookie('session', { secure: true, sameSite: 'none' });
    res.json({ ok: true });
  });

  app.get('/api/auth/session', requireAuth, function session(req, res) {
    res.json({ gpid: req.gpid });
  });

  app.get('/api/media', requireAuth, asyncRoute(async (req, res) => {
    const playlist = await catalog.getPlaylist();
    res.json({
      media: playlist.items,
      playlistUrl: storage.publicUrl(catalog.keys.PLAYLIST_KEY)
    });
  }));

  async function saveVideoOutput(originalFile, outputPath, outputInfo, uploadedBy) {
    const stat = await fs.stat(outputPath);
    if (stat.size > MAX_OUTPUT_MB * 1024 * 1024) {
      throw new Error(
        'O vídeo processado ficou com ' +
        Math.ceil(stat.size / 1024 / 1024) +
        ' MB, acima do limite configurado de ' + MAX_OUTPUT_MB + ' MB.'
      );
    }

    const displayName = safeBaseName(originalFile.originalname) + '.mp4';
    const key = 'media/' + crypto.randomUUID() + '-' + displayName;
    await storage.putFile(
      key,
      outputPath,
      'video/mp4',
      'public, max-age=3600'
    );

    try {
      return await catalog.addMedia({
        name: displayName,
        originalName: originalFile.originalname,
        key,
        type: 'video',
        sizeBytes: stat.size,
        durationSeconds: outputInfo.durationSeconds,
        videoCodec: outputInfo.video && outputInfo.video.codec_name,
        audioCodec: outputInfo.audio && outputInfo.audio.codec_name,
        uploadedBy
      });
    } catch (error) {
      await storage.deleteObject(key).catch(() => {});
      throw error;
    }
  }

  app.post(
    '/api/media/upload',
    requireAuth,
    upload.single('file'),
    asyncRoute(async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'Selecione um vídeo.' });
      }

      try {
        const extension = extOf(req.file.originalname);
        if (!VIDEO_EXT.includes(extension)) {
          return res.status(400).json({
            error: 'Formato não suportado. Selecione um arquivo de vídeo.'
          });
        }

        const media = await withTempDir(async (dir) => {
          const outputPath = path.join(dir, 'output.mp4');
          const outputInfo = await ffmpeg.transcodeVideo(req.file.path, {
            keepOriginalAudio: true
          }, outputPath);
          return saveVideoOutput(req.file, outputPath, outputInfo, req.gpid);
        });

        res.json({ ok: true, media, name: media.name });
      } finally {
        await removeUploadedFiles(req.file);
      }
    })
  );

  app.post('/api/media/reorder', requireAuth, asyncRoute(async (req, res) => {
    const order = Array.isArray(req.body && req.body.order) ? req.body.order : [];
    const playlist = await catalog.reorderMedia(order);
    res.json({ ok: true, media: playlist.items });
  }));

  app.delete('/api/media/:id', requireAuth, asyncRoute(async (req, res) => {
    const playlist = await catalog.getPlaylist();
    const item = playlist.items.find((candidate) => candidate.id === req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Mídia não encontrada.' });
    }
    await storage.deleteObject(item.key);
    await catalog.removeMedia(item.id);
    res.json({ ok: true });
  }));

  app.get('/api/config', requireAuth, asyncRoute(async (req, res) => {
    const config = await catalog.getConfig(DEFAULT_CONFIG);
    res.json({
      config,
      configUrl: storage.publicUrl(catalog.keys.CONFIG_KEY)
    });
  }));

  app.put('/api/config', requireAuth, asyncRoute(async (req, res) => {
    const config = sanitizeConfig(req.body);
    await catalog.saveConfig(config);
    res.json({ ok: true, config });
  }));

  app.get('/api/music', requireAuth, asyncRoute(async (req, res) => {
    const library = await catalog.getMusicLibrary();
    res.json({ music: library.items });
  }));

  app.post(
    '/api/music/upload',
    requireAuth,
    upload.array('files', 20),
    asyncRoute(async (req, res) => {
      const created = [];
      try {
        for (const file of req.files || []) {
          const extension = extOf(file.originalname);
          if (!AUDIO_EXT.includes(extension)) {
            throw new Error('Formato de áudio não suportado: ' + file.originalname);
          }

          const key =
            'music/' + crypto.randomUUID() + '-' +
            safeBaseName(file.originalname) + '.' + extension;
          await storage.putFile(
            key,
            file.path,
            contentTypeForAudio(extension),
            'public, max-age=3600'
          );
          const stat = await fs.stat(file.path);
          const track = await catalog.addMusic({
            name: file.originalname,
            key,
            sizeBytes: stat.size,
            uploadedBy: req.gpid
          });
          created.push(track);
        }
        res.json({ ok: true, count: created.length, music: created });
      } finally {
        await removeUploadedFiles(req.files);
      }
    })
  );

  app.delete('/api/music/:id', requireAuth, asyncRoute(async (req, res) => {
    const library = await catalog.getMusicLibrary();
    const track = library.items.find((candidate) => candidate.id === req.params.id);
    if (!track) {
      return res.status(404).json({ error: 'Música não encontrada.' });
    }
    await storage.deleteObject(track.key);
    await catalog.removeMusic(track.id);
    res.json({ ok: true });
  }));

  async function downloadMusicToTemp(track, dir) {
    if (!track) { return null; }
    const content = await storage.getBuffer(track.key);
    if (!content) { throw new Error('A música selecionada não foi encontrada no armazenamento.'); }
    const musicPath = path.join(dir, 'music.' + extOf(track.name));
    await fs.writeFile(musicPath, content);
    return musicPath;
  }

  async function pickRandomMusic() {
    const library = await catalog.getMusicLibrary();
    if (!library.items.length) { return null; }
    return library.items[Math.floor(Math.random() * library.items.length)];
  }

  async function findMusic(id) {
    if (!id) { return null; }
    const library = await catalog.getMusicLibrary();
    return library.items.find((track) => track.id === id) || null;
  }

  async function processMedia(req, res, detailed) {
    if (!req.file) {
      return res.status(400).json({ error: 'Selecione uma imagem.' });
    }

    try {
      const extension = extOf(req.file.originalname);
      if (!IMAGE_EXT.includes(extension)) {
        return res.status(400).json({
          error: 'O conversor aceita somente imagens JPG ou PNG.'
        });
      }

      const media = await withTempDir(async (dir) => {
        const outputPath = path.join(dir, 'output.mp4');
        let music = null;
        let durationSeconds = 60;

        if (detailed) {
          durationSeconds = clampNumber(req.body.durationSeconds, 60, 1, 3600);
          music = await findMusic(req.body.musicId);
          if (req.body.musicId && !music) {
            throw new Error('A música selecionada não existe mais na biblioteca.');
          }
        } else {
          music = await pickRandomMusic();
        }

        const musicPath = await downloadMusicToTemp(music, dir);
        const outputInfo = await ffmpeg.imageToVideo(
          req.file.path,
          musicPath,
          durationSeconds,
          outputPath
        );
        return saveVideoOutput(req.file, outputPath, outputInfo, req.gpid);
      });

      res.json({ ok: true, media, name: media.name });
    } finally {
      await removeUploadedFiles(req.file);
    }
  }

  app.post(
    '/api/process/simple',
    requireAuth,
    upload.single('file'),
    asyncRoute((req, res) => processMedia(req, res, false))
  );

  app.post(
    '/api/process/detailed',
    requireAuth,
    upload.single('file'),
    asyncRoute((req, res) => processMedia(req, res, true))
  );

  app.use(function notFound(req, res) {
    res.status(404).json({ error: 'Rota não encontrada.', code: 'NOT_FOUND' });
  });

  app.use(function errorHandler(error, req, res, next) {
    if (res.headersSent) { return next(error); }
    console.error(error);

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'O arquivo excede o limite de ' + MAX_UPLOAD_MB + ' MB.',
        code: 'FILE_TOO_LARGE'
      });
    }

    if (String(error.message || '').startsWith('Origem não autorizada:')) {
      return res.status(403).json({ error: error.message, code: 'ORIGIN_DENIED' });
    }

    res.status(error.status || 500).json({
      error: error.message || 'Falha interna no servidor.',
      code: 'INTERNAL_ERROR'
    });
  });

  return { app, storage, catalog };
}

if (require.main === module) {
  try {
    const { app } = createApp();
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log('Backend rodando na porta ' + PORT);
    });
    server.keepAliveTimeout = 120000;
    server.headersTimeout = 125000;
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { createApp, sanitizeConfig, safeBaseName };
