'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeviceCatalog, normalizeDeviceId, sanitizeDevice } = require('../devices');

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getJson: async (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
    putJson: async (key, value) => { values.set(key, structuredClone(value)); },
    deleteObject: async (key) => { values.delete(key); },
    publicUrl: (key) => 'https://media.example/' + key
  };
}

function generalCatalog(items) {
  return { getPlaylist: async () => ({ version: 1, updatedAt: 'general-v1', items }) };
}

test('normaliza identificadores para uso na URL', () => {
  assert.equal(normalizeDeviceId(' Recepção 01 '), 'recepcao-01');
  assert.equal(sanitizeDevice({ name: 'TV RH' }).id, 'tv-rh');
});

test('cadastra TV e cria playlist individual vazia', async () => {
  const storage = memoryStorage();
  const devices = createDeviceCatalog(storage, generalCatalog([]));
  const device = await devices.addDevice({
    id: 'recepcao-01', name: 'TV Recepção', playlistMode: 'mixed'
  });
  const registry = await devices.getRegistry();
  const playlist = await devices.getDevicePlaylist(device.id);
  assert.equal(registry.devices.length, 1);
  assert.equal(registry.devices[0].playlistMode, 'mixed');
  assert.deepEqual(playlist.items, []);
});

test('monta playlist mista sem duplicar mídia', async () => {
  const storage = memoryStorage();
  const general = [
    { id: 'a', key: 'media/a.mp4', name: 'A.mp4' },
    { id: 'b', key: 'media/b.mp4', name: 'B.mp4' }
  ];
  const devices = createDeviceCatalog(storage, generalCatalog(general));
  await devices.addDevice({ id: 'rh-01', name: 'TV RH', playlistMode: 'mixed' });
  await devices.setDeviceMedia('rh-01', ['b']);
  const effective = await devices.getEffectivePlaylist('rh-01');
  assert.deepEqual(effective.items.map((item) => item.id), ['a', 'b']);
  assert.equal(effective.mode, 'mixed');
});

test('playlist individual respeita a ordem escolhida', async () => {
  const storage = memoryStorage();
  const general = [
    { id: 'a', key: 'media/a.mp4', name: 'A.mp4' },
    { id: 'b', key: 'media/b.mp4', name: 'B.mp4' }
  ];
  const devices = createDeviceCatalog(storage, generalCatalog(general));
  await devices.addDevice({ id: 'diretoria', name: 'Diretoria', playlistMode: 'individual' });
  const playlist = await devices.setDeviceMedia('diretoria', ['b', 'a']);
  assert.deepEqual(playlist.items.map((item) => item.id), ['b', 'a']);
  assert.deepEqual(playlist.items.map((item) => item.order), [1, 2]);
});

test('sincroniza atualização e exclusão de mídia nas TVs', async () => {
  const storage = memoryStorage();
  const general = [{ id: 'a', key: 'media/a.mp4', name: 'A.mp4' }];
  const devices = createDeviceCatalog(storage, generalCatalog(general));
  await devices.addDevice({ id: 'recepcao', name: 'Recepção', playlistMode: 'individual' });
  await devices.setDeviceMedia('recepcao', ['a']);
  await devices.replaceMediaReference('a', { id: 'a', key: 'media/a-v2.mp4', name: 'A.mp4' });
  assert.equal((await devices.getDevicePlaylist('recepcao')).items[0].key, 'media/a-v2.mp4');
  await devices.removeMediaReference('a');
  assert.deepEqual((await devices.getDevicePlaylist('recepcao')).items, []);
});
