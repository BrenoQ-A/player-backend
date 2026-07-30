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
const { createProcessingQueue } = require('./processing-queue');
const { createProgressTracker } = require('./progress-tracker');
const { extractYouTubeAudio } = require('./youtube-audio');
const {
  createResetCode, digestResetCode, normalizeGpid,
  resetRecordIsActive, verifyResetCode
} = require('./password-reset');

const {
  GITHUB_TOKEN,
  PRIVATE_REPO,
  PRIVATE_BRANCH = 'main',
  JWT_SECRET,
  INVITE_CODE,
  ALLOWED_ORIGIN,
  ADMIN_GPIDS = '',
  PORT = 3000
} = process.env;

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const MAX_OUTPUT_MB = Number(process.env.MAX_OUTPUT_MB || 1000);
const MAX_PROCESSING_QUEUE = Number(process.env.MAX_PROCESSING_QUEUE || 4);
const SESSION_DAYS = 30;
const AUTH_CACHE_MS = Number(process.env.AUTH_CACHE_SECONDS || 60) * 1000;
const RESET_CODE_TTL_MS = Number(process.env.RESET_CODE_TTL_MINUTES || 30) * 60000;
const RESET_MAX_ATTEMPTS = Number(process.env.RESET_MAX_ATTEMPTS || 5);
const RESET_RATE_LIMIT_WINDOW_MS = 15 * 60000;
const RESET_RATE_LIMIT_MAX = 10;
const USERS_PATH = 'users.json';
const IMAGE_EXT = ['jpg', 'jpeg', 'png'];
const VIDEO_EXT = ['mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'mpeg', 'mpg'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'];
const ADMIN_GPID_SET = new Set(ADMIN_GPIDS.split(',').map(normalizeGpid).filter(Boolean));
const resetAttemptWindows = new Map();
let usersCache = null;
let usersCacheExpiresAt = 0;

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
  if (!file) {
    const empty = { users: [], sha: null };
    usersCache = empty;
    usersCacheExpiresAt = Date.now() + AUTH_CACHE_MS;
    return empty;
  }
  const decoded = Buffer.from(file.content, 'base64').toString('utf8');
  const loaded = { users: JSON.parse(decoded), sha: file.sha };
  usersCache = loaded;
  usersCacheExpiresAt = Date.now() + AUTH_CACHE_MS;
  return loaded;
}
async function loadUsersCached() {
  return usersCache && usersCacheExpiresAt > Date.now() ? usersCache : loadUsers();
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
  usersCache = { users, sha: result.content.sha };
  usersCacheExpiresAt = Date.now() + AUTH_CACHE_MS;
  return result.content.sha;
}

function authVersionOf(value) {
  const version = Number(value && value.authVersion);
  return Number.isSafeInteger(version) && version >= 1 ? version : 1;
}
function isAdminGpid(gpid) {
  return ADMIN_GPID_SET.has(normalizeGpid(gpid));
}
function issueToken(res, gpid, authVersion) {
  const token = jwt.sign({ gpid, authVersion: authVersionOf({ authVersion }) }, JWT_SECRET, {
    expiresIn: SESSION_DAYS + 'd'
  });
  res.cookie('session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
  return token;
}
function clearSessionCookie(res) {
  res.clearCookie('session', { secure: true, sameSite: 'none' });
}
function expiredSession(res) {
  return res.status(401).json({
    error: 'Sessão expirada, faça login novamente.',
    code: 'AUTH_EXPIRED'
  });
}

function requireAuth(req, res, next) {
  const authorization = req.get('authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  const token = bearer || (req.cookies && req.cookies.session);
  if (!token) {
    return res.status(401).json({ error: 'Não autenticado.', code: 'AUTH_REQUIRED' });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return expiredSession(res);
  }
  loadUsersCached().then(({ users }) => {
    const gpid = normalizeGpid(payload.gpid);
    const user = users.find((candidate) => normalizeGpid(candidate.gpid) === gpid);
    if (!user || authVersionOf(payload) !== authVersionOf(user)) {
      clearSessionCookie(res);
      return expiredSession(res);
    }
    req.gpid = gpid;
    req.user = user;
    req.isAdmin = isAdminGpid(gpid);
    next();
  }).catch(next);
}
function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({
      error: 'Somente um administrador pode realizar esta ação.',
      code: 'ADMIN_REQUIRED'
    });
  }
  next();
}
function allowResetAttempt(req, gpid) {
  const now = Date.now();
  const key = String(req.ip || req.socket.remoteAddress || 'unknown') + '|' + normalizeGpid(gpid);
  const current = resetAttemptWindows.get(key);
  if (!current || current.resetAt <= now) {
    resetAttemptWindows.set(key, { count: 1, resetAt: now + RESET_RATE_LIMIT_WINDOW_MS });
    return true;
  }
  current.count += 1;
  return current.count <= RESET_RATE_LIMIT_MAX;
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
  const processingQueue = createProcessingQueue({ maxPending: MAX_PROCESSING_QUEUE });
  const progressTracker = createProgressTracker();
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
  app.set('trust proxy', 1);
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
      processing: processingQueue.stats(),
      progress: progressTracker.stats(),
      timestamp: new Date().toISOString()
    });
  });

  app.get('/api/media/progress/:id', requireAuth, function mediaProgress(req, res) {
    const progress = progressTracker.get(req.params.id, req.gpid);
    if (!progress) {
      return res.status(404).json({
        error: 'Progresso não encontrado.',
        code: 'PROGRESS_NOT_FOUND'
      });
    }
    res.json({ progress });
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
    const user = { gpid: gpidNorm, passwordHash, authVersion: 1, createdAt: new Date().toISOString() };
    users.push(user);
    await saveUsers(users, sha, 'Novo usuário: ' + gpidNorm);
    const token = issueToken(res, gpidNorm, user.authVersion);
    res.json({ gpid: gpidNorm, token, isAdmin: isAdminGpid(gpidNorm) });
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

    const token = issueToken(res, gpidNorm, authVersionOf(user));
    res.json({ gpid: gpidNorm, token, isAdmin: isAdminGpid(gpidNorm) });
  }));

  app.post('/api/auth/logout', function logout(req, res) {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/session', requireAuth, function session(req, res) {
    res.json({ gpid: req.gpid, isAdmin: req.isAdmin });
  });

  app.post('/api/admin/password-resets', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    const targetGpid = normalizeGpid(req.body && req.body.gpid);
    if (!targetGpid) return res.status(400).json({ error: 'Informe o GPID do usuário.' });
    const { users, sha } = await loadUsers();
    const user = users.find((candidate) => normalizeGpid(candidate.gpid) === targetGpid);
    if (!user) {
      return res.status(404).json({
        error: 'Nenhum cadastro foi encontrado para esse GPID.',
        code: 'USER_NOT_FOUND'
      });
    }
    const resetCode = createResetCode();
    const now = Date.now();
    const expiresAt = new Date(now + RESET_CODE_TTL_MS).toISOString();
    user.passwordReset = {
      digest: digestResetCode(resetCode, targetGpid, JWT_SECRET),
      expiresAt,
      attemptsRemaining: RESET_MAX_ATTEMPTS,
      createdAt: new Date(now).toISOString(),
      createdBy: req.gpid
    };
    await saveUsers(users, sha, 'Gerar redefinição de senha: ' + targetGpid);
    res.json({ ok: true, gpid: targetGpid, resetCode, expiresAt, attempts: RESET_MAX_ATTEMPTS });
  }));

  app.post('/api/auth/reset-password', asyncRoute(async (req, res) => {
    const gpid = normalizeGpid(req.body && req.body.gpid);
    const resetCode = req.body && req.body.resetCode;
    const password = req.body && req.body.password;
    const genericError = {
      error: 'GPID ou código de redefinição inválido ou expirado.',
      code: 'RESET_INVALID'
    };
    if (!gpid || !resetCode || !password) {
      return res.status(400).json({ error: 'GPID, código e nova senha são obrigatórios.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 8 caracteres.' });
    }
    if (!allowResetAttempt(req, gpid)) {
      return res.status(429).json({
        error: 'Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.',
        code: 'RESET_RATE_LIMITED'
      });
    }
    const { users, sha } = await loadUsers();
    const user = users.find((candidate) => normalizeGpid(candidate.gpid) === gpid);
    const record = user && user.passwordReset;
    const active = resetRecordIsActive(record);
    const valid = active && verifyResetCode(resetCode, gpid, record.digest, JWT_SECRET);
    if (!valid) {
      digestResetCode(resetCode, gpid, JWT_SECRET);
      if (user && record) {
        if (active) record.attemptsRemaining = Math.max(0, Number(record.attemptsRemaining) - 1);
        if (!active || record.attemptsRemaining <= 0) delete user.passwordReset;
        await saveUsers(users, sha, 'Registrar tentativa de redefinição: ' + gpid);
      }
      return res.status(400).json(genericError);
    }
    user.passwordHash = await bcrypt.hash(String(password), 12);
    user.authVersion = authVersionOf(user) + 1;
    user.passwordChangedAt = new Date().toISOString();
    delete user.passwordReset;
    await saveUsers(users, sha, 'Redefinir senha: ' + gpid);
    clearSessionCookie(res);
    res.json({ ok: true, message: 'Senha redefinida. Entre novamente com a nova senha.' });
  }));

  app.get('/api/media', requireAuth, asyncRoute(async (req, res) => {
    const playlist = await catalog.getPlaylist();
    res.json({
      media: playlist.items,
      playlistUrl: storage.publicUrl(catalog.keys.PLAYLIST_KEY)
    });
  }));

  async function saveVideoOutput(
    originalFile,
    outputPath,
    outputInfo,
    uploadedBy,
    onStorageProgress
  ) {
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
      'public, max-age=3600',
      onStorageProgress
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
        const uploadId = req.get('x-upload-id') || '';
        progressTracker.start(uploadId, req.gpid, req.file.originalname);
        const report = function report(patch) {
          progressTracker.update(uploadId, req.gpid, patch);
        };
        const reportStorage = function reportStorage(progress) {
          report({
            stage: 'publishing',
            percent: Math.floor((Number(progress.percent) || 0) * 10) / 10,
            message: 'Enviando o arquivo preparado ao armazenamento R2.'
          });
        };

        report({
          stage: 'checking',
          percent: 0,
          message: 'Verificando codecs, resolução, FPS e faststart.'
        });
        const extension = extOf(req.file.originalname);
        if (!VIDEO_EXT.includes(extension)) {
          report({
            stage: 'failed',
            message: 'Formato de vídeo não suportado.'
          });
          return res.status(400).json({
            error: 'Formato não suportado. Selecione um arquivo de vídeo.'
          });
        }

        const inputInfo = await ffmpeg.probe(req.file.path);
        const isMp4 = extension === 'mp4';
        const videoCompatible = ffmpeg.isSamsungVideoCompatible(inputInfo);
        const audioCompatible = ffmpeg.isSamsungAudioCompatible(inputInfo);
        const fastStart =
          isMp4 && videoCompatible && await ffmpeg.hasFastStart(req.file.path);
        let processing = 'direct';
        let media;

        if (isMp4 && videoCompatible && audioCompatible && fastStart) {
          processing = 'direct';
          report({
            stage: 'publishing',
            percent: 0,
            processing,
            message: 'Vídeo compatível. Publicando diretamente, sem conversão.'
          });
          media = await saveVideoOutput(
            req.file,
            req.file.path,
            inputInfo,
            req.gpid,
            reportStorage
          );
        } else {
          const queueState = processingQueue.stats();
          report({
            stage: 'queued',
            percent: 0,
            queuePosition: queueState.active + queueState.waiting + 1,
            message: 'Aguardando a vez na fila de processamento.'
          });
          media = await processingQueue.run(() => withTempDir(async (dir) => {
            const outputPath = path.join(dir, 'output.mp4');
            let outputInfo;

            if (videoCompatible) {
              processing = audioCompatible ? 'remuxed' : 'audio-transcoded';
              report({
                stage: audioCompatible ? 'remuxing' : 'audio-transcoding',
                percent: 0,
                processing,
                queuePosition: null,
                message: audioCompatible
                  ? 'Reorganizando o MP4 sem recodificar o vídeo.'
                  : 'Preservando o vídeo e convertendo somente o áudio.'
              });
              outputInfo = await ffmpeg.remuxVideo(req.file.path, {
                inputInfo,
                transcodeAudio: !audioCompatible,
                onProgress: (progress) => report({ percent: progress.percent })
              }, outputPath);
            } else {
              processing = 'transcoded';
              report({
                stage: 'transcoding',
                percent: 0,
                processing,
                queuePosition: null,
                message: 'Recodificando o vídeo para o perfil compatível com a TV.'
              });
              outputInfo = await ffmpeg.transcodeVideo(req.file.path, {
                keepOriginalAudio: true,
                inputInfo,
                onProgress: (progress) => report({ percent: progress.percent })
              }, outputPath);
            }

            report({
              stage: 'publishing',
              percent: 0,
              processing,
              message: 'Processamento concluído. Enviando ao armazenamento R2.'
            });
            return saveVideoOutput(
              req.file,
              outputPath,
              outputInfo,
              req.gpid,
              reportStorage
            );
          }));
        }

        report({
          stage: 'complete',
          percent: 100,
          processing,
          message: 'Vídeo publicado com sucesso.'
        });
        res.json({
          ok: true,
          media,
          name: media.name,
          processing
        });
      } catch (error) {
        const uploadId = req.get('x-upload-id') || '';
        progressTracker.update(uploadId, req.gpid, {
          stage: 'failed',
          message: error.message || 'Falha ao processar o vídeo.'
        });
        throw error;
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

  app.post('/api/music/youtube', requireAuth, asyncRoute(async (req, res) => {
    const url = req.body && req.body.url;
    const authorized = req.body && req.body.authorized;
    if (authorized !== true) {
      return res.status(400).json({
        error: 'Confirme que você tem autorização para utilizar esse conteúdo.',
        code: 'CONTENT_AUTHORIZATION_REQUIRED'
      });
    }

    const track = await processingQueue.run(() => withTempDir(async (dir) => {
      const extracted = await extractYouTubeAudio(url, dir);
      const storedName = safeBaseName(extracted.title) + '.mp3';
      const key = 'music/' + crypto.randomUUID() + '-' + storedName;

      await storage.putFile(
        key,
        extracted.filePath,
        'audio/mpeg',
        'public, max-age=3600'
      );
      try {
        return await catalog.addMusic({
          name: extracted.title + '.mp3',
          key,
          sizeBytes: extracted.sizeBytes,
          durationSeconds: extracted.durationSeconds,
          source: 'youtube',
          sourceUrl: extracted.sourceUrl,
          sourceId: extracted.sourceId,
          uploadedBy: req.gpid
        });
      } catch (error) {
        await storage.deleteObject(key).catch(() => {});
        throw error;
      }
    }));

    res.json({ ok: true, music: track });
  }));

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
    const musicPath = path.join(dir, 'music.' + extOf(track.name));
    const found = await storage.getFile(track.key, musicPath);
    if (!found) { throw new Error('A música selecionada não foi encontrada no armazenamento.'); }
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

      const media = await processingQueue.run(() => withTempDir(async (dir) => {
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
      }));

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
      code: error.code || 'INTERNAL_ERROR'
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
