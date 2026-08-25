'use strict';

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const PLAYLIST_KEY = 'playlist-staging.json';
const CONFIG_KEY = 'config-staging.json';

const DEFAULT_CONFIG = {
  imageDurationSeconds: 15,
  pollIntervalMinutes: 5,
  startMuted: false,
  showHud: true,
  autoReloadHours: 6,
  targetVolume: 0.8,
  videoVolumeOverrides: {},
  fillBorderColor: false,
  musicEnabled: false,
  musicPlaylist: [],
  imageMusicDurationSeconds: 40,
  musicVolume: 0.5,
  legacyFitMode: 'cover',
  legacyCanvasWidth: 1280,
  legacyCanvasHeight: 720
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) { return fallback; }
  return Math.min(max, Math.max(min, number));
}

function sanitizeConfig(source) {
  const input = source && typeof source === 'object' ? source : {};
  const fit = String(input.legacyFitMode || DEFAULT_CONFIG.legacyFitMode).toLowerCase();
  const overrides = input.videoVolumeOverrides && typeof input.videoVolumeOverrides === 'object' &&
    !Array.isArray(input.videoVolumeOverrides) ? input.videoVolumeOverrides : {};

  return {
    imageDurationSeconds: clampNumber(input.imageDurationSeconds, 15, 1, 3600),
    pollIntervalMinutes: clampNumber(input.pollIntervalMinutes, 5, 1, 1440),
    startMuted: !!input.startMuted,
    showHud: input.showHud !== undefined ? !!input.showHud : true,
    autoReloadHours: clampNumber(input.autoReloadHours, 6, 0, 168),
    targetVolume: clampNumber(input.targetVolume, 0.8, 0, 1),
    videoVolumeOverrides: overrides,
    fillBorderColor: !!input.fillBorderColor,
    musicEnabled: !!input.musicEnabled,
    musicPlaylist: Array.isArray(input.musicPlaylist) ? input.musicPlaylist : [],
    imageMusicDurationSeconds: clampNumber(input.imageMusicDurationSeconds, 40, 1, 3600),
    musicVolume: clampNumber(input.musicVolume, 0.5, 0, 1),
    legacyFitMode: ['contain', 'cover', 'stretch'].includes(fit) ? fit : 'cover',
    legacyCanvasWidth: clampNumber(input.legacyCanvasWidth, 1280, 320, 7680),
    legacyCanvasHeight: clampNumber(input.legacyCanvasHeight, 720, 240, 4320)
  };
}

function normalizeGpid(value) {
  return String(value || '').trim().toUpperCase();
}

function createAdminMiddleware() {
  const secret = process.env.JWT_SECRET || '';
  const admins = new Set(
    String(process.env.ADMIN_GPIDS || '')
      .split(',')
      .map(normalizeGpid)
      .filter(Boolean)
  );

  return function requireStagingAdmin(req, res, next) {
    const authorization = req.get('authorization') || '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    const token = bearer || (req.cookies && req.cookies.session);
    let payload;

    if (!token) {
      return res.status(401).json({ error: 'Não autenticado.', code: 'AUTH_REQUIRED' });
    }

    try {
      payload = jwt.verify(token, secret);
    } catch (error) {
      return res.status(401).json({ error: 'Sessão expirada.', code: 'AUTH_EXPIRED' });
    }

    req.gpid = normalizeGpid(payload.gpid);
    if (!admins.has(req.gpid)) {
      return res.status(403).json({
        error: 'Somente um administrador pode alterar o staging.',
        code: 'ADMIN_REQUIRED'
      });
    }
    next();
  };
}

function createStagingManager(storage, productionCatalog) {
  let mutationQueue = Promise.resolve();

  function serialize(fn) {
    const operation = mutationQueue.then(fn, fn);
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  async function getPlaylist() {
    const data = await storage.getJson(PLAYLIST_KEY, null);
    if (!data || !Array.isArray(data.items)) {
      return { version: 1, environment: 'staging', updatedAt: null, items: [] };
    }
    data.items.sort((a, b) => (a.order || 0) - (b.order || 0));
    return data;
  }

  async function savePlaylist(playlist) {
    const output = clone(playlist || {});
    output.version = 1;
    output.environment = 'staging';
    output.updatedAt = new Date().toISOString();
    output.items = Array.isArray(output.items) ? output.items : [];
    output.items.forEach((item, index) => {
      item.order = index + 1;
      if (item.key) { item.url = storage.publicUrl(item.key); }
    });
    await storage.putJson(PLAYLIST_KEY, output);
    return output;
  }

  function stagingCopy(item) {
    const copyItem = clone(item);
    copyItem.sourceId = item.id || item.sourceId || null;
    copyItem.id = crypto.randomUUID();
    copyItem.environment = 'staging';
    copyItem.stagedAt = new Date().toISOString();
    delete copyItem.order;
    return copyItem;
  }

  async function copyFromProduction(ids) {
    return serialize(async () => {
      const production = await productionCatalog.getPlaylist();
      const selectedIds = new Set((Array.isArray(ids) ? ids : []).map(String));
      const selected = selectedIds.size
        ? production.items.filter((item) => selectedIds.has(String(item.id)))
        : [];
      const playlist = await getPlaylist();
      const existingSourceIds = new Set(playlist.items.map((item) => String(item.sourceId || '')));
      const added = [];

      selected.forEach((item) => {
        if (!item.key || existingSourceIds.has(String(item.id))) { return; }
        const staged = stagingCopy(item);
        playlist.items.push(staged);
        existingSourceIds.add(String(item.id));
        added.push(staged);
      });

      await savePlaylist(playlist);
      return { added, playlist: await getPlaylist() };
    });
  }

  async function syncFromProduction() {
    return serialize(async () => {
      const production = await productionCatalog.getPlaylist();
      const playlist = {
        version: 1,
        environment: 'staging',
        items: production.items.filter((item) => item && item.key).map(stagingCopy)
      };
      return savePlaylist(playlist);
    });
  }

  async function removeMedia(id) {
    return serialize(async () => {
      const playlist = await getPlaylist();
      const index = playlist.items.findIndex((item) => String(item.id) === String(id));
      if (index === -1) { return null; }
      const removed = playlist.items.splice(index, 1)[0];
      await savePlaylist(playlist);
      return removed;
    });
  }

  async function reorderMedia(ids) {
    return serialize(async () => {
      const playlist = await getPlaylist();
      const byId = new Map(playlist.items.map((item) => [String(item.id), item]));
      const ordered = [];
      (Array.isArray(ids) ? ids : []).forEach((id) => {
        const key = String(id);
        if (!byId.has(key)) { return; }
        ordered.push(byId.get(key));
        byId.delete(key);
      });
      playlist.items = ordered.concat(Array.from(byId.values()));
      return savePlaylist(playlist);
    });
  }

  async function clearPlaylist() {
    return serialize(async () => savePlaylist({ version: 1, environment: 'staging', items: [] }));
  }

  async function getConfig() {
    const data = await storage.getJson(CONFIG_KEY, null);
    return data ? sanitizeConfig(data) : clone(DEFAULT_CONFIG);
  }

  async function saveConfig(config) {
    const output = sanitizeConfig(config);
    await storage.putJson(CONFIG_KEY, output);
    return output;
  }

  async function ensure() {
    const playlist = await storage.getJson(PLAYLIST_KEY, null);
    if (!playlist || !Array.isArray(playlist.items)) {
      await savePlaylist({ version: 1, environment: 'staging', items: [] });
    }
    const config = await storage.getJson(CONFIG_KEY, null);
    if (!config) {
      await saveConfig(DEFAULT_CONFIG);
    }
  }

  return {
    keys: { PLAYLIST_KEY, CONFIG_KEY },
    getPlaylist,
    savePlaylist,
    copyFromProduction,
    syncFromProduction,
    removeMedia,
    reorderMedia,
    clearPlaylist,
    getConfig,
    saveConfig,
    ensure
  };
}

function createCorsMiddleware() {
  const allowedOrigins = String(process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return cors({
    credentials: true,
    origin: function origin(requestOrigin, callback) {
      if (!requestOrigin || allowedOrigins.includes(requestOrigin)) {
        callback(null, requestOrigin || allowedOrigins[0]);
      } else {
        callback(new Error('Origem não autorizada: ' + requestOrigin));
      }
    }
  });
}

function createStagingRouter(manager, productionCatalog, storage) {
  const router = express.Router();
  const requireAdmin = createAdminMiddleware();

  router.use(createCorsMiddleware());
  router.use(cookieParser());
  router.use(express.json({ limit: '1mb' }));
  router.use(requireAdmin);

  router.get('/state', async function state(req, res, next) {
    try {
      const [staging, production, config] = await Promise.all([
        manager.getPlaylist(),
        productionCatalog.getPlaylist(),
        manager.getConfig()
      ]);
      res.json({
        environment: 'staging',
        media: staging.items,
        productionMedia: production.items,
        config,
        playlistUrl: storage.publicUrl(manager.keys.PLAYLIST_KEY),
        configUrl: storage.publicUrl(manager.keys.CONFIG_KEY)
      });
    } catch (error) { next(error); }
  });

  router.get('/media', async function media(req, res, next) {
    try {
      const playlist = await manager.getPlaylist();
      res.json({
        environment: 'staging',
        media: playlist.items,
        playlistUrl: storage.publicUrl(manager.keys.PLAYLIST_KEY)
      });
    } catch (error) { next(error); }
  });

  router.post('/media/copy', async function copyMedia(req, res, next) {
    try {
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
      if (!ids.length) {
        return res.status(400).json({ error: 'Selecione ao menos uma mídia de produção.' });
      }
      const result = await manager.copyFromProduction(ids);
      res.json({ ok: true, added: result.added, media: result.playlist.items });
    } catch (error) { next(error); }
  });

  router.post('/media/sync-production', async function syncProduction(req, res, next) {
    try {
      const playlist = await manager.syncFromProduction();
      res.json({ ok: true, media: playlist.items });
    } catch (error) { next(error); }
  });

  router.post('/media/reorder', async function reorder(req, res, next) {
    try {
      const order = Array.isArray(req.body && req.body.order) ? req.body.order : [];
      const playlist = await manager.reorderMedia(order);
      res.json({ ok: true, media: playlist.items });
    } catch (error) { next(error); }
  });

  router.delete('/media/clear', async function clear(req, res, next) {
    try {
      const playlist = await manager.clearPlaylist();
      res.json({ ok: true, media: playlist.items });
    } catch (error) { next(error); }
  });

  router.delete('/media/:id', async function remove(req, res, next) {
    try {
      const removed = await manager.removeMedia(req.params.id);
      if (!removed) { return res.status(404).json({ error: 'Mídia de staging não encontrada.' }); }
      const playlist = await manager.getPlaylist();
      res.json({ ok: true, removed, media: playlist.items });
    } catch (error) { next(error); }
  });

  router.get('/config', async function getConfig(req, res, next) {
    try { res.json({ config: await manager.getConfig() }); }
    catch (error) { next(error); }
  });

  router.put('/config', async function putConfig(req, res, next) {
    try { res.json({ ok: true, config: await manager.saveConfig(req.body || {}) }); }
    catch (error) { next(error); }
  });

  router.use(function stagingError(error, req, res, next) {
    console.error('Staging API:', error);
    if (res.headersSent) { return next(error); }
    res.status(500).json({ error: 'Falha interna no ambiente de staging.' });
  });

  return router;
}

module.exports = {
  PLAYLIST_KEY,
  CONFIG_KEY,
  DEFAULT_CONFIG,
  sanitizeConfig,
  createStagingManager,
  createStagingRouter
};
