'use strict';

const crypto = require('crypto');

const PLAYLIST_KEY = 'playlist.json';
const MUSIC_KEY = 'music-library.json';
const CONFIG_KEY = 'config.json';

function normalizedMediaName(item) {
  return String(item && (item.originalName || item.name) || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function legacyMediaSignature(item) {
  const name = normalizedMediaName(item);
  const size = Number(item && item.sizeBytes);
  const duration = Number(item && item.durationSeconds);
  if (!name || !Number.isFinite(size) || size <= 0 ||
      !Number.isFinite(duration) || duration <= 0) {
    return '';
  }
  return [String(item.type || 'video'), name, size, Math.round(duration * 1000)].join('|');
}

function findDuplicateMedia(items, candidate) {
  const hash = String(candidate && candidate.contentHash || '');
  const legacy = legacyMediaSignature(candidate);
  return items.find((item) => {
    if (candidate.id && item.id === candidate.id) { return false; }
    const itemHash = String(item.contentHash || '');
    if (hash && itemHash) { return hash === itemHash; }
    return !!legacy && legacy === legacyMediaSignature(item);
  }) || null;
}

function createCatalog(storage) {
  let mutationQueue = Promise.resolve();

  function serialize(fn) {
    const operation = mutationQueue.then(fn, fn);
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  async function getPlaylist() {
    const data = await storage.getJson(PLAYLIST_KEY, null);
    if (!data || !Array.isArray(data.items)) {
      return { version: 1, updatedAt: null, items: [] };
    }
    data.items.sort((a, b) => (a.order || 0) - (b.order || 0));
    return data;
  }

  async function savePlaylist(playlist) {
    playlist.version = 1;
    playlist.updatedAt = new Date().toISOString();
    playlist.items.forEach((item, index) => {
      item.order = index + 1;
      item.url = storage.publicUrl(item.key);
    });
    await storage.putJson(PLAYLIST_KEY, playlist);
    return playlist;
  }

  async function addMedia(item) {
    return serialize(async () => {
      const playlist = await getPlaylist();
      const media = Object.assign({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString()
      }, item);
      const duplicate = findDuplicateMedia(playlist.items, media);
      if (duplicate) {
        const error = new Error('Este conteúdo já está publicado na playlist.');
        error.code = 'MEDIA_DUPLICATE';
        error.media = duplicate;
        throw error;
      }
      playlist.items.push(media);
      await savePlaylist(playlist);
      return media;
    });
  }

  async function replaceMedia(id, patch) {
    return serialize(async () => {
      const playlist = await getPlaylist();
      const index = playlist.items.findIndex((item) => item.id === id);
      if (index === -1) { return null; }
      const previous = playlist.items[index];
      const replacement = Object.assign({}, previous, patch, {
        id: previous.id,
        createdAt: previous.createdAt
      });
      playlist.items[index] = replacement;
      await savePlaylist(playlist);
      return { previous, media: replacement };
    });
  }

  async function deduplicateMedia() {
    return serialize(async () => {
      const playlist = await getPlaylist();
      const kept = [];
      const removed = [];

      playlist.items.forEach((item) => {
        if (findDuplicateMedia(kept, item)) {
          removed.push(item);
        } else {
          kept.push(item);
        }
      });

      if (removed.length) {
        playlist.items = kept;
        await savePlaylist(playlist);
      }
      return { playlist, removed };
    });
  }

  async function removeMedia(id) {
    return serialize(async () => {
      const playlist = await getPlaylist();
      const index = playlist.items.findIndex((item) => item.id === id);
      if (index === -1) { return null; }
      const removed = playlist.items.splice(index, 1)[0];
      await savePlaylist(playlist);
      return removed;
    });
  }

  async function reorderMedia(ids) {
    return serialize(async () => {
      const playlist = await getPlaylist();
      const byId = new Map(playlist.items.map((item) => [item.id, item]));
      const ordered = [];

      ids.forEach((id) => {
        const item = byId.get(id);
        if (item) {
          ordered.push(item);
          byId.delete(id);
        }
      });

      playlist.items = ordered.concat(Array.from(byId.values()));
      await savePlaylist(playlist);
      return playlist;
    });
  }

  async function getMusicLibrary() {
    const data = await storage.getJson(MUSIC_KEY, null);
    if (!data || !Array.isArray(data.items)) {
      return { version: 1, updatedAt: null, items: [] };
    }
    return data;
  }

  async function saveMusicLibrary(library) {
    library.version = 1;
    library.updatedAt = new Date().toISOString();
    library.items.forEach((item) => { item.url = storage.publicUrl(item.key); });
    await storage.putJson(MUSIC_KEY, library);
    return library;
  }

  async function addMusic(item) {
    return serialize(async () => {
      const library = await getMusicLibrary();
      const track = Object.assign({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString()
      }, item);
      library.items.push(track);
      await saveMusicLibrary(library);
      return track;
    });
  }

  async function removeMusic(id) {
    return serialize(async () => {
      const library = await getMusicLibrary();
      const index = library.items.findIndex((item) => item.id === id);
      if (index === -1) { return null; }
      const removed = library.items.splice(index, 1)[0];
      await saveMusicLibrary(library);
      return removed;
    });
  }

  async function getConfig(defaultConfig) {
    return storage.getJson(CONFIG_KEY, defaultConfig);
  }

  async function saveConfig(config) {
    await storage.putJson(CONFIG_KEY, config);
    return config;
  }

  return {
    keys: { PLAYLIST_KEY, MUSIC_KEY, CONFIG_KEY },
    getPlaylist,
    addMedia,
    replaceMedia,
    deduplicateMedia,
    removeMedia,
    reorderMedia,
    getMusicLibrary,
    addMusic,
    removeMusic,
    getConfig,
    saveConfig
  };
}

module.exports = { createCatalog };
