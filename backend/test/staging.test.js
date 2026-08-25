'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PLAYLIST_KEY,
  CONFIG_KEY,
  createStagingManager
} = require('../staging');

function createFakeStorage() {
  const values = new Map();
  return {
    async getJson(key, fallback) {
      return values.has(key) ? JSON.parse(JSON.stringify(values.get(key))) : fallback;
    },
    async putJson(key, value) {
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
    publicUrl(key) {
      return 'https://example.test/' + key;
    },
    values
  };
}

function createProductionCatalog() {
  return {
    async getPlaylist() {
      return {
        version: 1,
        items: [
          {
            id: 'prod-1',
            name: 'video-a.mp4',
            key: 'media/video-a.mp4',
            type: 'video',
            contentHash: 'hash-a'
          },
          {
            id: 'prod-2',
            name: 'video-b.mp4',
            key: 'media/video-b.mp4',
            type: 'video',
            contentHash: 'hash-b'
          }
        ]
      };
    }
  };
}

test('ensure cria playlist e configuração de staging sem tocar produção', async () => {
  const storage = createFakeStorage();
  const manager = createStagingManager(storage, createProductionCatalog());

  await manager.ensure();

  const playlist = storage.values.get(PLAYLIST_KEY);
  const config = storage.values.get(CONFIG_KEY);
  assert.equal(playlist.environment, 'staging');
  assert.deepEqual(playlist.items, []);
  assert.equal(config.legacyFitMode, 'cover');
  assert.equal(storage.values.has('playlist.json'), false);
  assert.equal(storage.values.has('config.json'), false);
});

test('copyFromProduction referencia o objeto existente sem alterar a playlist de produção', async () => {
  const storage = createFakeStorage();
  const manager = createStagingManager(storage, createProductionCatalog());
  await manager.ensure();

  const result = await manager.copyFromProduction(['prod-1']);

  assert.equal(result.added.length, 1);
  assert.equal(result.playlist.items.length, 1);
  assert.equal(result.playlist.items[0].sourceId, 'prod-1');
  assert.equal(result.playlist.items[0].key, 'media/video-a.mp4');
  assert.equal(result.playlist.items[0].url, 'https://example.test/media/video-a.mp4');
  assert.notEqual(result.playlist.items[0].id, 'prod-1');
});

test('syncFromProduction, reorder e clear operam apenas no staging', async () => {
  const storage = createFakeStorage();
  const manager = createStagingManager(storage, createProductionCatalog());
  await manager.ensure();

  let playlist = await manager.syncFromProduction();
  assert.equal(playlist.items.length, 2);

  const reversed = [playlist.items[1].id, playlist.items[0].id];
  playlist = await manager.reorderMedia(reversed);
  assert.equal(playlist.items[0].sourceId, 'prod-2');
  assert.equal(playlist.items[1].sourceId, 'prod-1');

  playlist = await manager.clearPlaylist();
  assert.deepEqual(playlist.items, []);
  assert.equal(storage.values.has('playlist.json'), false);
});
