'use strict';

const crypto = require('crypto');

const DEVICES_KEY = 'devices.json';
const PLAYLIST_MODES = new Set(['global', 'individual', 'mixed']);
const DEVICE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeDeviceId(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function sanitizeText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function sanitizeDevice(input, previous) {
  const source = input || {};
  const old = previous || {};
  const id = normalizeDeviceId(source.id || old.id || source.name);
  const playlistMode = PLAYLIST_MODES.has(source.playlistMode)
    ? source.playlistMode
    : (PLAYLIST_MODES.has(old.playlistMode) ? old.playlistMode : 'global');

  if (!id || !DEVICE_ID_PATTERN.test(id)) {
    const error = new Error('Informe um identificador válido para a TV.');
    error.code = 'DEVICE_ID_INVALID';
    error.status = 400;
    throw error;
  }

  const name = sanitizeText(source.name !== undefined ? source.name : old.name, 100);
  if (!name) {
    const error = new Error('Informe o nome da TV.');
    error.code = 'DEVICE_NAME_REQUIRED';
    error.status = 400;
    throw error;
  }

  return {
    id,
    name,
    location: sanitizeText(source.location !== undefined ? source.location : old.location, 160),
    model: sanitizeText(source.model !== undefined ? source.model : old.model, 120),
    profile: sanitizeText(source.profile !== undefined ? source.profile : old.profile, 64) || 'legacy-720p',
    playlistMode,
    createdAt: old.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function playlistKey(deviceId) {
  const id = normalizeDeviceId(deviceId);
  if (!id || !DEVICE_ID_PATTERN.test(id)) { throw new Error('TV inválida.'); }
  return 'devices/' + id + '/playlist.json';
}

function normalizePlaylist(data) {
  const playlist = data && Array.isArray(data.items) ? data : { version: 1, items: [] };
  playlist.items.sort((a, b) => (a.order || 0) - (b.order || 0));
  return playlist;
}

function createDeviceCatalog(storage, productionCatalog) {
  let mutationQueue = Promise.resolve();

  function serialize(fn) {
    const operation = mutationQueue.then(fn, fn);
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  async function getRegistry() {
    const data = await storage.getJson(DEVICES_KEY, null);
    if (!data || !Array.isArray(data.devices)) {
      return { version: 1, updatedAt: null, devices: [] };
    }
    data.devices.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'));
    return data;
  }

  async function saveRegistry(registry) {
    const output = {
      version: 1,
      updatedAt: new Date().toISOString(),
      devices: registry.devices
    };
    await storage.putJson(DEVICES_KEY, output);
    return output;
  }

  async function addDevice(input) {
    return serialize(async () => {
      const registry = await getRegistry();
      const device = sanitizeDevice(input);
      if (registry.devices.some((item) => item.id === device.id)) {
        const error = new Error('Já existe uma TV com esse identificador.');
        error.code = 'DEVICE_EXISTS';
        error.status = 409;
        throw error;
      }
      registry.devices.push(device);
      await saveRegistry(registry);
      await saveDevicePlaylist(device.id, { items: [] });
      return device;
    });
  }

  async function updateDevice(id, input) {
    return serialize(async () => {
      const registry = await getRegistry();
      const index = registry.devices.findIndex((item) => item.id === normalizeDeviceId(id));
      if (index === -1) { return null; }
      const device = sanitizeDevice(Object.assign({}, input, { id: registry.devices[index].id }), registry.devices[index]);
      registry.devices[index] = device;
      await saveRegistry(registry);
      return device;
    });
  }

  async function removeDevice(id) {
    return serialize(async () => {
      const registry = await getRegistry();
      const index = registry.devices.findIndex((item) => item.id === normalizeDeviceId(id));
      if (index === -1) { return null; }
      const removed = registry.devices.splice(index, 1)[0];
      await saveRegistry(registry);
      await storage.deleteObject(playlistKey(removed.id));
      return removed;
    });
  }

  async function getDevice(id) {
    const registry = await getRegistry();
    return registry.devices.find((item) => item.id === normalizeDeviceId(id)) || null;
  }

  async function getDevicePlaylist(id) {
    return normalizePlaylist(await storage.getJson(playlistKey(id), null));
  }

  async function saveDevicePlaylist(id, playlist) {
    const output = normalizePlaylist({
      version: 1,
      updatedAt: new Date().toISOString(),
      items: Array.isArray(playlist && playlist.items) ? playlist.items : []
    });
    output.items.forEach((item, index) => {
      item.order = index + 1;
      if (item.key) { item.url = storage.publicUrl(item.key); }
    });
    await storage.putJson(playlistKey(id), output);
    return output;
  }

  async function setDeviceMedia(id, mediaIds) {
    const device = await getDevice(id);
    if (!device) { return null; }
    const general = await productionCatalog.getPlaylist();
    const byId = new Map(general.items.map((item) => [String(item.id), item]));
    const items = [];
    const seen = new Set();
    (Array.isArray(mediaIds) ? mediaIds : []).forEach((mediaId) => {
      const item = byId.get(String(mediaId));
      if (item && !seen.has(String(item.id))) {
        items.push(Object.assign({}, item));
        seen.add(String(item.id));
      }
    });
    return saveDevicePlaylist(device.id, { items });
  }

  async function getEffectivePlaylist(id) {
    const device = await getDevice(id);
    if (!device) { return null; }
    const general = await productionCatalog.getPlaylist();
    const individual = await getDevicePlaylist(id);
    let items;
    if (device.playlistMode === 'individual') {
      items = individual.items;
    } else if (device.playlistMode === 'mixed') {
      const seen = new Set();
      items = general.items.concat(individual.items).filter((item) => {
        const signature = String(item.id || item.key || item.url || crypto.randomUUID());
        if (seen.has(signature)) { return false; }
        seen.add(signature);
        return true;
      });
    } else {
      items = general.items;
    }
    return {
      version: 1,
      updatedAt: [general.updatedAt || '', individual.updatedAt || '', device.updatedAt || ''].join('|'),
      deviceId: device.id,
      mode: device.playlistMode,
      items: items.map((item, index) => Object.assign({}, item, { order: index + 1 }))
    };
  }

  async function replaceMediaReference(mediaId, replacement) {
    return serialize(async () => {
      const registry = await getRegistry();
      let changed = 0;
      for (const device of registry.devices) {
        const playlist = await getDevicePlaylist(device.id);
        let dirty = false;
        playlist.items = playlist.items.map((item) => {
          if (String(item.id) !== String(mediaId)) { return item; }
          dirty = true;
          return Object.assign({}, replacement);
        });
        if (dirty) { await saveDevicePlaylist(device.id, playlist); changed += 1; }
      }
      return changed;
    });
  }

  async function removeMediaReference(mediaId) {
    return serialize(async () => {
      const registry = await getRegistry();
      let changed = 0;
      for (const device of registry.devices) {
        const playlist = await getDevicePlaylist(device.id);
        const kept = playlist.items.filter((item) => String(item.id) !== String(mediaId));
        if (kept.length !== playlist.items.length) {
          playlist.items = kept;
          await saveDevicePlaylist(device.id, playlist);
          changed += 1;
        }
      }
      return changed;
    });
  }

  return {
    keys: { DEVICES_KEY },
    getRegistry,
    addDevice,
    updateDevice,
    removeDevice,
    getDevice,
    getDevicePlaylist,
    setDeviceMedia,
    getEffectivePlaylist,
    replaceMediaReference,
    removeMediaReference,
    playlistKey
  };
}

module.exports = {
  DEVICES_KEY,
  PLAYLIST_MODES,
  normalizeDeviceId,
  sanitizeDevice,
  playlistKey,
  createDeviceCatalog
};
